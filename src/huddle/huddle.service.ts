import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID } from 'crypto'
import { and, or, asc, desc, eq, inArray, isNull, isNotNull } from 'drizzle-orm'
import {
  AccessToken,
  type WebhookEvent,
  WebhookReceiver,
  TrackSource,
  RoomServiceClient,
} from 'livekit-server-sdk'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { MessageService } from '../message/message.service'
import {
  channels,
  conversationMembers,
  directMessageConversations,
  messages,
  huddleParticipants,
  huddleSessions,
  users,
  workspaceMembers,
} from '../database/schema'
import {
  type HuddleEntityType,
  type HuddleMessageSnapshot,
  type HuddleJoinResponse,
  type HuddleParticipantSnapshot,
  type HuddleSessionSnapshot,
  type HuddleSessionStatus,
  type HuddleStateSnapshot,
} from './huddle.types'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
import {
  HuddleBroadcastService,
  type HuddleBroadcastPayload,
} from './huddle-broadcast.service'

type HuddleSessionRow = typeof huddleSessions.$inferSelect
type HuddleParticipantRow = typeof huddleParticipants.$inferSelect
type HuddleParticipantDisplayRow = HuddleParticipantRow & {
  workspaceMemberId: string | null
  workspaceMemberStatus: 'active' | 'deactivated' | null
  workspaceMemberEmail: string | null
  workspaceMemberName: string | null
  workspaceMemberDisplayName: string | null
  workspaceMemberAvatar: string | null
  email: string | null
  userName: string | null
  userAvatar: string | null
}

type ParticipantMediaSnapshot = {
  isMuted: boolean
  isCameraOn: boolean
  isScreenSharing: boolean
  isSpeaking: boolean
}

type LiveKitConfig = {
  url: string
  apiKey: string
  apiSecret: string
}

type AccessResolution = {
  workspaceId: string
  entityType: HuddleEntityType
  entityId: string
}

const HUDDLE_PENDING_SESSION_TTL_MS = 15 * 60 * 1000
const HUDDLE_IDLE_ACTIVE_SESSION_TTL_MS = 2 * 60 * 1000

@Injectable()
export class HuddleService {
  private readonly logger = new Logger(HuddleService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly messageService: MessageService,
    private readonly configService: ConfigService,
    private readonly broadcastService: HuddleBroadcastService,
    @Inject(forwardRef(() => ChatBroadcastService))
    private readonly chatBroadcastService: ChatBroadcastService,
  ) {}

  private requireLiveKitConfig(): LiveKitConfig {
    const url = this.configService.get<string>('LIVEKIT_URL')
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY')
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET')

    if (!url || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException(
        'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.',
      )
    }

    return { url, apiKey, apiSecret }
  }

  private roomName(target: AccessResolution) {
    return `huddle:${target.workspaceId}:${target.entityType}:${target.entityId}`
  }

  private activeKey(target: AccessResolution) {
    return `${target.workspaceId}:${target.entityType}:${target.entityId}`
  }

  private eventTimeFromBigint(createdAt?: bigint) {
    if (!createdAt) return new Date()
    const value = Number(createdAt)
    if (Number.isNaN(value) || value <= 0) return new Date()
    return new Date(value * 1000)
  }

  private parseRoomName(roomName: string): AccessResolution | null {
    if (!roomName.startsWith('huddle:')) return null
    const parts = roomName.split(':')
    if (parts.length < 4) return null
    const workspaceId = parts[1]?.trim()
    const entityType = parts[2]?.trim() as HuddleEntityType | undefined
    const entityId = parts.slice(3).join(':').trim()
    if (!workspaceId || !entityType || !entityId) return null
    if (entityType !== 'channel' && entityType !== 'dm') return null
    return { workspaceId, entityType, entityId }
  }

  private async resolveTargetLabel(
    target: AccessResolution,
    viewerUserId: string | null,
  ) {
    if (target.entityType === 'channel') {
      const [channel] = await this.db
        .select({
          name: channels.name,
        })
        .from(channels)
        .where(eq(channels.id, target.entityId))
        .limit(1)
      return channel?.name?.trim() || null
    }

    const memberRows = await this.db
      .select({
        userId: users.id,
        name: workspaceMembers.name,
        displayName: workspaceMembers.displayName,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .innerJoin(
        directMessageConversations,
        eq(directMessageConversations.id, conversationMembers.conversationId),
      )
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(
            workspaceMembers.workspaceId,
            directMessageConversations.workspaceId,
          ),
        ),
      )
      .where(eq(conversationMembers.conversationId, target.entityId))

    const names = memberRows
      .filter((row) => row.userId !== viewerUserId)
      .map(
        (row) => row.displayName?.trim() || row.name?.trim() || 'Participant',
      )
      .filter(Boolean)

    if (names.length === 0) {
      const [conversation] = await this.db
        .select({
          workspaceId: directMessageConversations.workspaceId,
        })
        .from(directMessageConversations)
        .where(eq(directMessageConversations.id, target.entityId))
        .limit(1)
      return conversation ? 'Huddle' : null
    }

    return names.join(', ')
  }

  private async resolveTarget(
    workspaceId: string,
    entityType: HuddleEntityType,
    entityId: string,
    userId: string,
  ): Promise<AccessResolution> {
    let resolvedWorkspaceId: string
    if (entityType === 'channel') {
      await this.messageService.assertRealtimeChannelAccess(entityId, userId)
      const [channel] = await this.db
        .select({
          workspaceId: channels.workspaceId,
        })
        .from(channels)
        .where(eq(channels.id, entityId))
        .limit(1)
      resolvedWorkspaceId = channel?.workspaceId ?? ''
    } else {
      await this.messageService.assertRealtimeConversationAccess(
        entityId,
        userId,
      )
      const [conversation] = await this.db
        .select({
          workspaceId: directMessageConversations.workspaceId,
        })
        .from(directMessageConversations)
        .where(eq(directMessageConversations.id, entityId))
        .limit(1)
      resolvedWorkspaceId = conversation?.workspaceId ?? ''
    }

    if (resolvedWorkspaceId !== workspaceId) {
      throw new NotFoundException('Huddle target not found')
    }

    return { workspaceId, entityType, entityId }
  }

  private async findOpenSession(target: AccessResolution) {
    return this.db.query.huddleSessions.findFirst({
      where: and(
        eq(huddleSessions.workspaceId, target.workspaceId),
        eq(huddleSessions.entityType, target.entityType),
        eq(huddleSessions.entityId, target.entityId),
        isNull(huddleSessions.endedAt),
      ),
      orderBy: desc(huddleSessions.startedAt),
    })
  }

  private async findRecentSessions(target: AccessResolution, limit = 5) {
    return this.db.query.huddleSessions.findMany({
      where: and(
        eq(huddleSessions.workspaceId, target.workspaceId),
        eq(huddleSessions.entityType, target.entityType),
        eq(huddleSessions.entityId, target.entityId),
      ),
      orderBy: desc(huddleSessions.startedAt),
      limit,
    })
  }

  private async findParticipants(sessionIds: string[]) {
    if (sessionIds.length === 0) return []
    return (await this.db
      .select({
        id: huddleParticipants.id,
        sessionId: huddleParticipants.sessionId,
        userId: huddleParticipants.userId,
        joinedAt: huddleParticipants.joinedAt,
        leftAt: huddleParticipants.leftAt,
        isMuted: huddleParticipants.isMuted,
        isCameraOn: huddleParticipants.isCameraOn,
        isScreenSharing: huddleParticipants.isScreenSharing,
        isSpeaking: huddleParticipants.isSpeaking,
        workspaceMemberId: workspaceMembers.id,
        workspaceMemberStatus: workspaceMembers.membershipStatus,
        workspaceMemberEmail: workspaceMembers.email,
        workspaceMemberName: workspaceMembers.name,
        workspaceMemberDisplayName: workspaceMembers.displayName,
        workspaceMemberAvatar: workspaceMembers.avatar,
        email: users.email,
        userName: users.name,
        userAvatar: users.avatar,
      })
      .from(huddleParticipants)
      .innerJoin(
        huddleSessions,
        eq(huddleSessions.id, huddleParticipants.sessionId),
      )
      .innerJoin(users, eq(users.id, huddleParticipants.userId))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, huddleParticipants.userId),
          eq(workspaceMembers.workspaceId, huddleSessions.workspaceId),
        ),
      )
      .where(inArray(huddleParticipants.sessionId, sessionIds))
      .orderBy(
        asc(huddleParticipants.joinedAt),
      )) as HuddleParticipantDisplayRow[]
  }

  private async findHuddleFeedMessages(sessionIds: string[]) {
    if (sessionIds.length === 0) return []
    return this.db
      .select({
        id: messages.id,
        userId: messages.userId,
        huddleSessionId: messages.huddleSessionId,
        content: messages.content,
        huddleSnapshot: messages.huddleSnapshot,
      })
      .from(messages)
      .where(inArray(messages.huddleSessionId, sessionIds))
  }

  private async hasActiveParticipants(sessionId: string) {
    const [activeParticipant] = await this.db
      .select({ id: huddleParticipants.id })
      .from(huddleParticipants)
      .where(
        and(
          eq(huddleParticipants.sessionId, sessionId),
          isNull(huddleParticipants.leftAt),
        ),
      )
      .limit(1)
    return Boolean(activeParticipant)
  }

  private normalizeParticipant(
    row: HuddleParticipantDisplayRow,
  ): HuddleParticipantSnapshot {
    const membershipStatus =
      row.workspaceMemberStatus === 'active' ? 'active' : 'deactivated'
    const isActive = membershipStatus === 'active'
    const displayName = isActive
      ? row.workspaceMemberDisplayName?.trim() ||
        row.workspaceMemberName?.trim() ||
        row.userName?.trim() ||
        'Participant'
      : 'deactivated user'
    const name = isActive
      ? row.workspaceMemberName?.trim() || row.userName?.trim() || 'Participant'
      : 'deactivated user'
    const avatar = isActive
      ? (row.workspaceMemberAvatar ?? row.userAvatar ?? null)
      : null
    return {
      id: row.id,
      sessionId: row.sessionId,
      userId: row.userId,
      email: row.email,
      name,
      displayName,
      avatar,
      membershipStatus,
      joinedAt: row.joinedAt.toISOString(),
      leftAt: row.leftAt?.toISOString() ?? null,
      isMuted: row.isMuted,
      isCameraOn: row.isCameraOn,
      isScreenSharing: row.isScreenSharing,
      isSpeaking: row.isSpeaking,
    }
  }

  private normalizeSession(
    row: HuddleSessionRow,
    participants: HuddleParticipantDisplayRow[],
    feedMessageId: string | null = null,
  ): HuddleSessionSnapshot {
    const normalizedParticipants = participants.map((participant) =>
      this.normalizeParticipant(participant),
    )
    const activeParticipantCount = normalizedParticipants.filter(
      (participant) => participant.leftAt === null,
    ).length

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      entityType: row.entityType,
      entityId: row.entityId,
      roomName: row.roomName,
      entityActiveKey: row.entityActiveKey ?? null,
      feedMessageId,
      status: row.status,
      startedById: row.startedById ?? null,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      lastActivityAt: row.lastActivityAt.toISOString(),
      participantCount: normalizedParticipants.length,
      activeParticipantCount,
      participants: normalizedParticipants,
      topic: row.topic ?? null,
    }
  }

  private deriveMediaState(
    tracks: Array<{ source?: number; muted?: boolean }>,
  ) {
    const hasMicrophoneTrack = tracks.some(
      (track) => track.source === TrackSource.MICROPHONE,
    )
    const microphoneTrack = tracks.find(
      (track) => track.source === TrackSource.MICROPHONE,
    )
    const hasCameraTrack = tracks.some(
      (track) => track.source === TrackSource.CAMERA,
    )
    const cameraTrack = tracks.find(
      (track) => track.source === TrackSource.CAMERA,
    )
    const hasScreenShareTrack = tracks.some(
      (track) =>
        track.source === TrackSource.SCREEN_SHARE ||
        track.source === TrackSource.SCREEN_SHARE_AUDIO,
    )
    const screenShareTrack = tracks.find(
      (track) =>
        track.source === TrackSource.SCREEN_SHARE ||
        track.source === TrackSource.SCREEN_SHARE_AUDIO,
    )

    return {
      isMuted: hasMicrophoneTrack ? Boolean(microphoneTrack?.muted) : false,
      isCameraOn: hasCameraTrack ? !cameraTrack?.muted : false,
      isScreenSharing: hasScreenShareTrack ? !screenShareTrack?.muted : false,
      isSpeaking: false,
    }
  }

  private async fetchState(
    target: AccessResolution,
  ): Promise<HuddleStateSnapshot> {
    const now = new Date()
    const activeSession = await this.cleanupOpenSessionIfStale(target, now)
    await this.syncHuddleFeedMessage(target, null)
    const recentSessions = await this.findRecentSessions(target, 5)
    const sessionIds = Array.from(
      new Set(
        [...recentSessions, ...(activeSession ? [activeSession] : [])].map(
          (session) => session.id,
        ),
      ),
    )
    const participantRows = await this.findParticipants(sessionIds)
    const feedMessageRows = await this.findHuddleFeedMessages(sessionIds)
    const participantsBySessionId = participantRows.reduce<
      Record<string, HuddleParticipantDisplayRow[]>
    >((acc, participant) => {
      if (!acc[participant.sessionId]) acc[participant.sessionId] = []
      acc[participant.sessionId].push(participant)
      return acc
    }, {})
    const feedMessageIdBySessionId = feedMessageRows.reduce<
      Record<string, string>
    >((acc, row) => {
      if (row.huddleSessionId) {
        acc[row.huddleSessionId] = row.id
      }
      return acc
    }, {})

    const normalizedActiveSession = activeSession
      ? this.normalizeSession(
          activeSession,
          participantsBySessionId[activeSession.id] ?? [],
          feedMessageIdBySessionId[activeSession.id] ?? null,
        )
      : null

    const normalizedRecentSessions = recentSessions
      .filter((session) => session.id !== activeSession?.id)
      .map((session) =>
        this.normalizeSession(
          session,
          participantsBySessionId[session.id] ?? [],
          feedMessageIdBySessionId[session.id] ?? null,
        ),
      )

    return {
      activeSession: normalizedActiveSession,
      recentSessions: normalizedRecentSessions,
    }
  }

  private async createSessionRow(
    target: AccessResolution,
    userId: string | null,
    status: HuddleSessionStatus,
    startedAt: Date,
  ): Promise<HuddleSessionRow> {
    const values = {
      id: randomUUID(),
      workspaceId: target.workspaceId,
      entityType: target.entityType,
      entityId: target.entityId,
      entityActiveKey: this.activeKey(target),
      roomName: this.roomName(target),
      status,
      startedById: userId,
      startedAt,
      endedAt: null,
      lastActivityAt: startedAt,
    }

    try {
      const [inserted] = await this.db
        .insert(huddleSessions)
        .values(values)
        .returning()
      return inserted ?? null
    } catch (error) {
      this.logger.warn(
        `Failed to create huddle session for ${values.roomName}: ${String(error)}`,
      )
      const existing = await this.findOpenSession(target)
      if (existing) {
        return existing
      }
      throw error
    }
  }

  private async upsertParticipantSnapshot(
    sessionId: string,
    userId: string,
    snapshot: {
      joinedAt: Date
      leftAt: Date | null
    } & ParticipantMediaSnapshot,
  ) {
    await this.db
      .insert(huddleParticipants)
      .values({
        id: randomUUID(),
        sessionId,
        userId,
        ...snapshot,
      })
      .onConflictDoUpdate({
        target: [huddleParticipants.sessionId, huddleParticipants.userId],
        set: {
          joinedAt: snapshot.joinedAt,
          leftAt: snapshot.leftAt,
          isMuted: snapshot.isMuted,
          isCameraOn: snapshot.isCameraOn,
          isScreenSharing: snapshot.isScreenSharing,
          isSpeaking: snapshot.isSpeaking,
        },
      })
  }

  private async markParticipantLeftSnapshot(
    sessionId: string,
    userId: string,
    snapshot: {
      leftAt: Date
    } & ParticipantMediaSnapshot,
  ) {
    const [existing] = await this.db
      .select({
        id: huddleParticipants.id,
      })
      .from(huddleParticipants)
      .where(
        and(
          eq(huddleParticipants.sessionId, sessionId),
          eq(huddleParticipants.userId, userId),
        ),
      )
      .limit(1)

    if (existing) {
      await this.db
        .update(huddleParticipants)
        .set({
          leftAt: snapshot.leftAt,
          isMuted: snapshot.isMuted,
          isCameraOn: snapshot.isCameraOn,
          isScreenSharing: snapshot.isScreenSharing,
          isSpeaking: snapshot.isSpeaking,
        })
        .where(eq(huddleParticipants.id, existing.id))
      return
    }

    await this.db.insert(huddleParticipants).values({
      id: randomUUID(),
      sessionId,
      userId,
      joinedAt: snapshot.leftAt,
      leftAt: snapshot.leftAt,
      isMuted: snapshot.isMuted,
      isCameraOn: snapshot.isCameraOn,
      isScreenSharing: snapshot.isScreenSharing,
      isSpeaking: snapshot.isSpeaking,
    })
  }

  private async updateSessionStatus(
    sessionId: string,
    patch: Partial<{
      status: HuddleSessionStatus
      entityActiveKey: string | null
      startedAt: Date
      endedAt: Date | null
      lastActivityAt: Date
      startedById: string | null
    }>,
  ) {
    const [updated] = await this.db
      .update(huddleSessions)
      .set(patch)
      .where(eq(huddleSessions.id, sessionId))
      .returning()
    return updated ?? null
  }

  private huddleFeedCopy(status: HuddleSessionStatus) {
    return status === 'ended' ? 'A huddle happened' : 'A huddle is happening'
  }

  private async syncHuddleFeedMessage(
    target: AccessResolution,
    actorUserId: string | null,
  ) {
    const openSession = await this.findOpenSession(target)
    const latestSession =
      openSession ?? (await this.findRecentSessions(target, 1))[0] ?? null
    if (!latestSession) return null

    const participants = await this.findParticipants([latestSession.id])
    const [existingMessage] = await this.findHuddleFeedMessages([
      latestSession.id,
    ])
    const messageUserId =
      actorUserId ??
      participants[0]?.userId ??
      latestSession.startedById ??
      existingMessage?.userId ??
      null
    if (!messageUserId) return null

    const entityLabel = await this.resolveTargetLabel(
      target,
      actorUserId ?? latestSession.startedById ?? null,
    )
    const sessionSnapshot = this.normalizeSession(
      latestSession,
      participants,
      existingMessage?.id ?? null,
    )
    const huddleSnapshot: HuddleMessageSnapshot = {
      ...sessionSnapshot,
      entityLabel,
    }
    const content = this.huddleFeedCopy(latestSession.status)
    const room =
      target.entityType === 'channel'
        ? `channel:${target.entityId}`
        : `conversation:${target.entityId}`
    const existingSnapshotJson = existingMessage?.huddleSnapshot
      ? JSON.stringify(existingMessage.huddleSnapshot)
      : null
    const nextSnapshotJson = JSON.stringify(huddleSnapshot)

    if (
      existingMessage &&
      existingMessage.content === content &&
      existingSnapshotJson === nextSnapshotJson
    ) {
      return existingMessage.id
    }

    if (existingMessage) {
      await this.db
        .update(messages)
        .set({
          content,
          type: 'huddle',
          huddleSessionId: latestSession.id,
          huddleSnapshot,
          allowEdit: false,
          workspaceId: target.workspaceId,
          channelId: target.entityType === 'channel' ? target.entityId : null,
          conversationId: target.entityType === 'dm' ? target.entityId : null,
          updatedAt: new Date(),
        })
        .where(eq(messages.id, existingMessage.id))
      try {
        const updated = await this.messageService.getMessageById(
          existingMessage.id,
          messageUserId,
        )
        this.chatBroadcastService.broadcastMessageUpdated(
          room,
          updated,
          undefined,
          updated.recipientIds.recipientIds,
          target.workspaceId,
        )
      } catch (error) {
        this.logger.warn(
          `Failed to broadcast huddle message update for ${existingMessage.id}: ${String(error)}`,
        )
      }
      return existingMessage.id
    }

    const [inserted] = await this.db
      .insert(messages)
      .values({
        id: randomUUID(),
        workspaceId: target.workspaceId,
        channelId: target.entityType === 'channel' ? target.entityId : null,
        conversationId: target.entityType === 'dm' ? target.entityId : null,
        userId: messageUserId,
        content,
        type: 'huddle',
        parentId: null,
        huddleSessionId: latestSession.id,
        huddleSnapshot,
        alsoSendToChannel: false,
        allowEdit: false,
      })
      .returning({ id: messages.id })

    if (!inserted?.id) return null

    try {
      const created = await this.messageService.getMessageById(
        inserted.id,
        messageUserId,
      )
      this.chatBroadcastService.broadcastMessage(room, created, undefined)
    } catch (error) {
      this.logger.warn(
        `Failed to broadcast huddle message creation for ${inserted.id}: ${String(error)}`,
      )
    }
    return inserted.id
  }

  private async endSession(sessionId: string, now: Date) {
    await this.updateSessionStatus(sessionId, {
      status: 'ended',
      endedAt: now,
      lastActivityAt: now,
      entityActiveKey: null,
    })

    await this.db
      .update(huddleParticipants)
      .set({
        leftAt: now,
      })
      .where(
        and(
          eq(huddleParticipants.sessionId, sessionId),
          isNull(huddleParticipants.leftAt),
        ),
      )
  }

  private async cleanupOpenSessionIfStale(target: AccessResolution, now: Date) {
    const session = await this.findOpenSession(target)
    if (!session) return null

    const sessionAgeMs = now.getTime() - session.startedAt.getTime()
    const idleMs = now.getTime() - session.lastActivityAt.getTime()

    if (
      session.status === 'pending' &&
      sessionAgeMs > HUDDLE_PENDING_SESSION_TTL_MS
    ) {
      await this.endSession(session.id, now)
      return null
    }

    if (session.status === 'active') {
      const hasActiveParticipants = await this.hasActiveParticipants(session.id)
      if (
        !hasActiveParticipants &&
        idleMs > HUDDLE_IDLE_ACTIVE_SESSION_TTL_MS
      ) {
        await this.endSession(session.id, now)
        return null
      }
    }

    return session
  }

  private async findOrCreateOpenSession(
    target: AccessResolution,
    userId: string,
    status: HuddleSessionStatus,
    now: Date,
  ): Promise<HuddleSessionRow> {
    const existing = await this.findOpenSession(target)
    if (existing) {
      const nextStatus =
        status === 'active' || existing.status !== 'active'
          ? status
          : existing.status

      if (existing.status !== nextStatus) {
        const [updated] = await this.db
          .update(huddleSessions)
          .set({
            status: nextStatus,
            lastActivityAt: now,
            startedById: existing.startedById ?? userId,
          })
          .where(eq(huddleSessions.id, existing.id))
          .returning()
        return updated ?? existing
      }

      await this.db
        .update(huddleSessions)
        .set({
          lastActivityAt: now,
          startedById: existing.startedById ?? userId,
        })
        .where(eq(huddleSessions.id, existing.id))

      return existing
    }

    return this.createSessionRow(target, userId, status, now)
  }

  private async ensureTarget(
    workspaceId: string,
    entityType: HuddleEntityType,
    entityId: string,
    userId: string,
  ) {
    return this.resolveTarget(workspaceId, entityType, entityId, userId)
  }

  private async broadcastState(
    target: AccessResolution,
    reason: HuddleBroadcastPayload['reason'],
    excludeSocketId?: string,
  ) {
    const state = await this.fetchState(target)
    this.broadcastService.broadcastState(
      target,
      {
        reason,
        target,
        state,
        session: state.activeSession,
      },
      excludeSocketId,
    )
    return state
  }

  private async ensureSessionForWebhook(
    target: AccessResolution,
    event: WebhookEvent,
  ): Promise<HuddleSessionRow> {
    const now = this.eventTimeFromBigint(event.createdAt)
    const existing = await this.findOpenSession(target)
    if (existing) return existing

    return this.createSessionRow(target, null, 'active', now)
  }

  private async updateParticipantJoinedFromWebhook(
    sessionId: string,
    participant: {
      identity: string
      tracks: Array<{ source?: number; muted?: boolean }>
    },
    eventTime: Date,
  ) {
    const mediaState = this.deriveMediaState(participant.tracks ?? [])
    await this.upsertParticipantSnapshot(sessionId, participant.identity, {
      joinedAt: eventTime,
      leftAt: null,
      isMuted: mediaState.isMuted,
      isCameraOn: mediaState.isCameraOn,
      isScreenSharing: mediaState.isScreenSharing,
      isSpeaking: mediaState.isSpeaking,
    })
  }

  private async updateParticipantLeftFromWebhook(
    sessionId: string,
    participant: {
      identity: string
      tracks: Array<{ source?: number; muted?: boolean }>
    },
    eventTime: Date,
  ) {
    const mediaState = this.deriveMediaState(participant.tracks ?? [])
    await this.markParticipantLeftSnapshot(sessionId, participant.identity, {
      leftAt: eventTime,
      isMuted: mediaState.isMuted,
      isCameraOn: mediaState.isCameraOn,
      isScreenSharing: mediaState.isScreenSharing,
      isSpeaking: mediaState.isSpeaking,
    })
  }

  private async endSessionIfRosterEmpty(sessionId: string, now: Date) {
    const [activeParticipant] = await this.db
      .select({ id: huddleParticipants.id })
      .from(huddleParticipants)
      .where(
        and(
          eq(huddleParticipants.sessionId, sessionId),
          isNull(huddleParticipants.leftAt),
        ),
      )
      .limit(1)

    if (activeParticipant) return false

    await this.updateSessionStatus(sessionId, {
      status: 'ended',
      endedAt: now,
      lastActivityAt: now,
      entityActiveKey: null,
    })
    return true
  }

  async getState(
    workspaceId: string,
    entityType: HuddleEntityType,
    entityId: string,
    userId: string,
  ) {
    const target = await this.ensureTarget(
      workspaceId,
      entityType,
      entityId,
      userId,
    )
    return this.fetchState(target)
  }

  async startHuddle(
    workspaceId: string,
    entityType: HuddleEntityType,
    entityId: string,
    userId: string,
    excludeSocketId?: string,
  ) {
    const target = await this.ensureTarget(
      workspaceId,
      entityType,
      entityId,
      userId,
    )
    const now = new Date()
    await this.cleanupOpenSessionIfStale(target, now)
    const session = await this.findOrCreateOpenSession(
      target,
      userId,
      'pending',
      now,
    )
    if (!session) {
      throw new BadRequestException('Could not create huddle session')
    }

    const state = await this.broadcastState(target, 'start', excludeSocketId)
    return state
  }

  async joinHuddle(
    workspaceId: string,
    entityType: HuddleEntityType,
    entityId: string,
    userId: string,
    excludeSocketId?: string,
  ): Promise<HuddleJoinResponse> {
    const target = await this.ensureTarget(
      workspaceId,
      entityType,
      entityId,
      userId,
    )
    const now = new Date()
    await this.cleanupOpenSessionIfStale(target, now)
    const session =
      (await this.findOrCreateOpenSession(target, userId, 'active', now)) ??
      (await this.createSessionRow(target, userId, 'active', now))

    if (!session) {
      throw new BadRequestException('Could not create huddle session')
    }

    await this.updateSessionStatus(session.id, {
      status: 'active',
      startedById: session.startedById ?? userId,
      lastActivityAt: now,
      entityActiveKey: this.activeKey(target),
    })

    await this.upsertParticipantSnapshot(session.id, userId, {
      joinedAt: now,
      leftAt: null,
      isMuted: false,
      isCameraOn: false,
      isScreenSharing: false,
      isSpeaking: false,
    })

    const [joinParticipant] = await this.db
      .select({
        workspaceMemberDisplayName: workspaceMembers.displayName,
        workspaceMemberName: workspaceMembers.name,
        workspaceMemberAvatar: workspaceMembers.avatar,
        userName: users.name,
        userAvatar: users.avatar,
      })
      .from(users)
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, target.workspaceId),
        ),
      )
      .where(eq(users.id, userId))
      .limit(1)

    const tokenDisplayName =
      joinParticipant?.workspaceMemberDisplayName?.trim() ||
      joinParticipant?.workspaceMemberName?.trim() ||
      joinParticipant?.userName?.trim() ||
      userId
    const tokenAvatar =
      joinParticipant?.workspaceMemberAvatar?.trim() ||
      joinParticipant?.userAvatar?.trim() ||
      null

    const config = this.requireLiveKitConfig()
    const token = new AccessToken(config.apiKey, config.apiSecret, {
      identity: userId,
      ttl: '1h',
      name: tokenDisplayName,
      metadata: JSON.stringify({
        workspaceId: target.workspaceId,
        entityType: target.entityType,
        entityId: target.entityId,
        sessionId: session.id,
        displayName: tokenDisplayName,
        avatar: tokenAvatar,
      }),
    })
    token.addGrant({
      roomJoin: true,
      room: session.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources: [
        TrackSource.MICROPHONE,
        TrackSource.CAMERA,
        TrackSource.SCREEN_SHARE,
        TrackSource.SCREEN_SHARE_AUDIO,
      ],
      canUpdateOwnMetadata: true,
    })

    const state = await this.broadcastState(target, 'join', excludeSocketId)
    if (!state.activeSession) {
      throw new BadRequestException('Could not resolve active huddle session')
    }

    return {
      livekitUrl: config.url,
      token: await token.toJwt(),
      session: state.activeSession,
    }
  }

  async leaveHuddle(
    workspaceId: string,
    entityType: HuddleEntityType,
    entityId: string,
    userId: string,
    excludeSocketId?: string,
  ) {
    const target = await this.ensureTarget(
      workspaceId,
      entityType,
      entityId,
      userId,
    )
    const now = new Date()
    await this.cleanupOpenSessionIfStale(target, now)
    const session = await this.findOpenSession(target)
    if (!session) {
      return this.fetchState(target)
    }

    await this.upsertParticipantSnapshot(session.id, userId, {
      joinedAt: now,
      leftAt: now,
      isMuted: false,
      isCameraOn: false,
      isScreenSharing: false,
      isSpeaking: false,
    })

    await this.updateSessionStatus(session.id, {
      lastActivityAt: now,
    })

    await this.endSessionIfRosterEmpty(session.id, now)

    return this.broadcastState(target, 'leave', excludeSocketId)
  }

  async muteParticipant(
    workspaceId: string,
    huddleId: string,
    participantIdentity: string,
    requestingUserId: string,
  ) {
    const target = await this.ensureTarget(
      workspaceId,
      'channel',
      huddleId,
      requestingUserId,
    )
    const session = await this.findOpenSession(target)
    if (!session) {
      throw new NotFoundException('Huddle session not found')
    }

    const config = this.requireLiveKitConfig()
    const roomService = new RoomServiceClient(
      config.url,
      config.apiKey,
      config.apiSecret,
    )

    const participant = await roomService.getParticipant(
      this.roomName(target),
      participantIdentity,
    )

    // Find audio track by source directly on TrackInfo
    const audioTrack = participant.tracks.find(
      (t) => t.source === TrackSource.MICROPHONE,
    )
    if (!audioTrack?.sid) {
      throw new NotFoundException('Participant has no audio track to mute')
    }

    await roomService.mutePublishedTrack(
      this.roomName(target),
      participantIdentity,
      audioTrack.sid,
      true,
    )

    // Get existing participant snapshot to preserve joinedAt
    const [existingSnapshot] = await this.db
      .select({ joinedAt: huddleParticipants.joinedAt })
      .from(huddleParticipants)
      .where(
        and(
          eq(huddleParticipants.sessionId, session.id),
          eq(huddleParticipants.userId, participantIdentity),
        ),
      )
      .limit(1)

    await this.upsertParticipantSnapshot(session.id, participantIdentity, {
      joinedAt: existingSnapshot?.joinedAt ?? new Date(),
      leftAt: null,
      isMuted: true,
      isCameraOn: participant.metadata
        ? (JSON.parse(participant.metadata).isCameraOn ?? false)
        : false,
      isScreenSharing: participant.metadata
        ? (JSON.parse(participant.metadata).isScreenSharing ?? false)
        : false,
      isSpeaking: false,
    })

    await this.broadcastService.broadcastState(target, {
      reason: 'state',
      target,
      state: await this.fetchState(target),
      session: null,
    })

    return { success: true, muted: participantIdentity }
  }

  async handleWebhook(rawBody: string, authorization?: string) {
    const config = this.requireLiveKitConfig()
    const receiver = new WebhookReceiver(config.apiKey, config.apiSecret)

    let event: WebhookEvent
    try {
      event = await receiver.receive(rawBody, authorization)
    } catch (error) {
      this.logger.warn(`LiveKit webhook verification failed: ${String(error)}`)
      throw new ForbiddenException('Invalid LiveKit webhook')
    }

    const roomName = event.room?.name ?? ''
    const target = this.parseRoomName(roomName)
    if (!target) {
      this.logger.debug(`Ignoring webhook for room '${roomName}'`)
      return { ignored: true }
    }

    const now = this.eventTimeFromBigint(event.createdAt)
    await this.cleanupOpenSessionIfStale(target, now)
    const session = await this.ensureSessionForWebhook(target, event)

    switch (event.event) {
      case 'room_started': {
        await this.updateSessionStatus(session.id, {
          status: 'active',
          lastActivityAt: now,
          entityActiveKey: this.activeKey(target),
          endedAt: null,
          startedAt: session.startedAt ?? now,
        })
        break
      }
      case 'participant_joined':
      case 'track_published': {
        const participant = event.participant
        if (!participant?.identity) break

        await this.updateSessionStatus(session.id, {
          status: 'active',
          lastActivityAt: now,
          entityActiveKey: this.activeKey(target),
          endedAt: null,
        })

        await this.updateParticipantJoinedFromWebhook(
          session.id,
          {
            identity: participant.identity,
            tracks: participant.tracks ?? [],
          },
          now,
        )
        break
      }
      case 'participant_left':
      case 'participant_connection_aborted':
      case 'track_unpublished': {
        const participant = event.participant
        if (participant?.identity) {
          await this.updateParticipantLeftFromWebhook(
            session.id,
            {
              identity: participant.identity,
              tracks: participant.tracks ?? [],
            },
            now,
          )
        }
        break
      }
      case 'room_finished': {
        await this.endSession(session.id, now)
        break
      }
      default:
        break
    }

    const state = await this.fetchState(target)
    this.broadcastService.broadcastState(target, {
      reason: 'webhook',
      target,
      state,
      session: state.activeSession,
    })

    if (event.event === 'participant_left' || event.event === 'room_finished') {
      await this.endSessionIfRosterEmpty(session.id, now)
    }

    return { ok: true }
  }

  /**
   * Get all active huddles for a user across all workspaces.
   * Used when user connects to WebSocket - we emit their current huddle state
   * so the frontend can show the ActiveHuddleIndicator after refresh.
   */
  async getUserActiveHuddles(userId: string): Promise<
    Array<{
      target: {
        workspaceId: string
        entityType: HuddleEntityType
        entityId: string
      }
      state: HuddleStateSnapshot
    }>
  > {
    // Find all active sessions where user is a participant with leftAt === null
    const activeParticipantSessions = await this.db
      .select({
        sessionId: huddleParticipants.sessionId,
        userId: huddleParticipants.userId,
      })
      .from(huddleParticipants)
      .innerJoin(
        huddleSessions,
        eq(huddleSessions.id, huddleParticipants.sessionId),
      )
      .where(
        and(
          eq(huddleParticipants.userId, userId),
          isNull(huddleParticipants.leftAt),
        ),
      )

    if (activeParticipantSessions.length === 0) {
      return []
    }

    const sessionIds = activeParticipantSessions.map((p) => p.sessionId)

    // Get all sessions with their targets
    const sessions = await this.db
      .select({
        id: huddleSessions.id,
        workspaceId: huddleSessions.workspaceId,
        entityType: huddleSessions.entityType,
        entityId: huddleSessions.entityId,
      })
      .from(huddleSessions)
      .where(inArray(huddleSessions.id, sessionIds))

    const results = await Promise.all(
      sessions.map(async (session) => {
        const target: {
          workspaceId: string
          entityType: HuddleEntityType
          entityId: string
        } = {
          workspaceId: session.workspaceId,
          entityType: session.entityType as HuddleEntityType,
          entityId: session.entityId,
        }
        const state = await this.fetchState(target)
        return { target, state }
      }),
    )

    // Filter to only include sessions where user is still in the active participants
    return results.filter((result) => {
      return result.state.activeSession?.participants.some(
        (p) => p.userId === userId && p.leftAt === null,
      )
    })
  }

  /**
   * Get ALL active huddles in a workspace that the user has access to.
   * Used to show huddle indicators on channels/DMs even when user is not in the huddle.
   * This returns huddles where:
   * - The user is a member of the entity (channel/DM)
   * - The huddle is active
   */
  async getUserAccessibleActiveHuddles(
    userId: string,
    workspaceId: string,
  ): Promise<
    Array<{
      target: {
        workspaceId: string
        entityType: HuddleEntityType
        entityId: string
      }
      state: HuddleStateSnapshot
    }>
  > {
    // Get user's accessible channels in this workspace
    const userChannels = await this.db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, channels.workspaceId),
      )
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
    const channelIds = userChannels.map((c) => c.id)

    // Get user's accessible DMs in this workspace
    const userDMs = await this.db
      .select({ id: directMessageConversations.id })
      .from(directMessageConversations)
      .innerJoin(
        conversationMembers,
        eq(conversationMembers.conversationId, directMessageConversations.id),
      )
      .where(
        and(
          eq(directMessageConversations.workspaceId, workspaceId),
          eq(conversationMembers.userId, userId),
        ),
      )
    const dmIds = userDMs.map((d) => d.id)

    // Find all active sessions in this workspace for accessible entities
    let sessions: Array<{
      id: string
      workspaceId: string
      entityType: string
      entityId: string
    }> = []

    // Query for channel huddles
    if (channelIds.length > 0) {
      const channelSessions = await this.db
        .select({
          id: huddleSessions.id,
          workspaceId: huddleSessions.workspaceId,
          entityType: huddleSessions.entityType,
          entityId: huddleSessions.entityId,
        })
        .from(huddleSessions)
        .where(
          and(
            eq(huddleSessions.workspaceId, workspaceId),
            eq(huddleSessions.entityType, 'channel'),
            inArray(huddleSessions.entityId, channelIds),
            isNull(huddleSessions.endedAt),
          ),
        )
      sessions = sessions.concat(channelSessions)
    }

    // Query for DM huddles
    if (dmIds.length > 0) {
      const dmSessions = await this.db
        .select({
          id: huddleSessions.id,
          workspaceId: huddleSessions.workspaceId,
          entityType: huddleSessions.entityType,
          entityId: huddleSessions.entityId,
        })
        .from(huddleSessions)
        .where(
          and(
            eq(huddleSessions.workspaceId, workspaceId),
            eq(huddleSessions.entityType, 'dm'),
            inArray(huddleSessions.entityId, dmIds),
            isNull(huddleSessions.endedAt),
          ),
        )
      sessions = sessions.concat(dmSessions)
    }

    if (sessions.length === 0) {
      return []
    }

    // Fetch state for each session
    const results = await Promise.all(
      sessions.map(async (session) => {
        const target: {
          workspaceId: string
          entityType: HuddleEntityType
          entityId: string
        } = {
          workspaceId: session.workspaceId,
          entityType: session.entityType as HuddleEntityType,
          entityId: session.entityId,
        }
        const state = await this.fetchState(target)
        return { target, state }
      }),
    )

    // Filter to only include sessions with active participants
    return results.filter((result) => {
      return result.state.activeSession !== null
    })
  }

  async updateTopic(
    workspaceId: string,
    huddleId: string,
    topic: string | null,
    userId: string,
  ) {
    // Find the session
    const [session] = await this.db
      .select({
        id: huddleSessions.id,
        workspaceId: huddleSessions.workspaceId,
        entityType: huddleSessions.entityType,
        entityId: huddleSessions.entityId,
      })
      .from(huddleSessions)
      .where(eq(huddleSessions.id, huddleId))
      .limit(1)

    if (!session) {
      throw new NotFoundException('Huddle session not found')
    }

    if (session.workspaceId !== workspaceId) {
      throw new NotFoundException('Huddle session not found in this workspace')
    }

    // Verify user is a participant
    const [participant] = await this.db
      .select({ id: huddleParticipants.id })
      .from(huddleParticipants)
      .where(
        and(
          eq(huddleParticipants.sessionId, huddleId),
          eq(huddleParticipants.userId, userId),
        ),
      )
      .limit(1)

    if (!participant) {
      throw new ForbiddenException(
        'You must be a participant to update the topic',
      )
    }

    // Update the topic
    await this.db
      .update(huddleSessions)
      .set({
        topic,
        lastActivityAt: new Date(),
      })
      .where(eq(huddleSessions.id, huddleId))

    // Broadcast the updated state
    const target: AccessResolution = {
      workspaceId: session.workspaceId,
      entityType: session.entityType as HuddleEntityType,
      entityId: session.entityId,
    }

    return this.broadcastState(target, 'topic_update')
  }

  async getWorkspaceHuddles(
    workspaceId: string,
    userId: string,
    filters: {
      filter_entityTypes?: 'all' | 'channel' | 'dm'
      filter_channelIds?: string[]
      filter_conversationIds?: string[]
      filter_participantIds?: string[]
      sort?: 'recent' | 'participants'
      status?: 'all' | 'active' | 'ended'
      missedOnly?: boolean
      page?: number
      pageSize?: number
    },
  ) {
    const {
      filter_entityTypes = 'all',
      filter_channelIds,
      filter_conversationIds,
      filter_participantIds,
      sort = 'recent',
      status = 'all',
      missedOnly = false,
      page = 1,
      pageSize = 20,
    } = filters

    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const activeCondition = isNull(huddleSessions.endedAt)
    const endedCondition = isNull(huddleSessions.entityActiveKey)

    let whereCondition: ReturnType<typeof and> = eq(
      huddleSessions.workspaceId,
      workspaceId,
    )

    if (filter_entityTypes === 'channel') {
      whereCondition = and(
        whereCondition,
        eq(huddleSessions.entityType, 'channel'),
      )
    } else if (filter_entityTypes === 'dm') {
      whereCondition = and(whereCondition, eq(huddleSessions.entityType, 'dm'))
    }

    if (status === 'active') {
      whereCondition = and(whereCondition, activeCondition)
    } else if (status === 'ended') {
      whereCondition = and(whereCondition, endedCondition)
    }

    // Build entity filter condition using OR when both channel and dm filters are present
    // "In" filter means: huddle must belong to ANY of the selected channels/dms
    const channelCondition =
      filter_channelIds && filter_channelIds.length > 0
        ? and(
            eq(huddleSessions.entityType, 'channel'),
            inArray(huddleSessions.entityId, filter_channelIds),
          )
        : null

    const dmCondition =
      filter_conversationIds && filter_conversationIds.length > 0
        ? and(
            eq(huddleSessions.entityType, 'dm'),
            inArray(huddleSessions.entityId, filter_conversationIds),
          )
        : null

    if (channelCondition && dmCondition) {
      // Both filters present: use OR
      whereCondition = and(whereCondition, or(channelCondition, dmCondition))
    } else if (channelCondition) {
      whereCondition = and(whereCondition, channelCondition)
    } else if (dmCondition) {
      whereCondition = and(whereCondition, dmCondition)
    }

    let allSessions = await this.db
      .select()
      .from(huddleSessions)
      .where(whereCondition)

    // For status='all', keep all sessions (active + ended within 30 days)
    // For status='ended', only show ended sessions within 30 days
    // For status='active', only show active sessions (handled by whereCondition)

    // "With" filter: ALL selected users must be participants in the huddle
    if (filter_participantIds && filter_participantIds.length > 0) {
      const participantSessionIds = await this.db
        .select({
          sessionId: huddleParticipants.sessionId,
          userId: huddleParticipants.userId,
        })
        .from(huddleParticipants)
        .where(inArray(huddleParticipants.userId, filter_participantIds))

      // Group by sessionId and count unique users per session
      const userCountPerSession = new Map<string, Set<string>>()
      for (const row of participantSessionIds) {
        if (!userCountPerSession.has(row.sessionId)) {
          userCountPerSession.set(row.sessionId, new Set())
        }
        userCountPerSession.get(row.sessionId)!.add(row.userId)
      }

      // Keep only sessions where ALL selected users are participants
      allSessions = allSessions.filter((session) => {
        const usersInSession = userCountPerSession.get(session.id)
        if (!usersInSession) return false
        return filter_participantIds.every((userId) =>
          usersInSession.has(userId),
        )
      })
    }

    // MissedOnly: show ended huddles the user did NOT participate in
    if (missedOnly) {
      if (userId) {
        const userParticipantSessions = await this.db
          .select({ sessionId: huddleParticipants.sessionId })
          .from(huddleParticipants)
          .where(eq(huddleParticipants.userId, userId))

        const attendedSet = new Set(
          userParticipantSessions.map((p) => p.sessionId),
        )
        allSessions = allSessions.filter(
          (session) => session.endedAt !== null && !attendedSet.has(session.id),
        )
      } else {
        // No userId, treat all ended sessions as missed
        allSessions = allSessions.filter((session) => session.endedAt !== null)
      }
    }

    if (sort === 'participants') {
      const sessionIdsForSort = allSessions.map((s) => s.id)
      const participantRowsForSort =
        await this.findParticipants(sessionIdsForSort)
      const participantsBySessionIdForSort = participantRowsForSort.reduce<
        Record<string, HuddleParticipantDisplayRow[]>
      >((acc, participant) => {
        if (!acc[participant.sessionId]) acc[participant.sessionId] = []
        acc[participant.sessionId].push(participant)
        return acc
      }, {})

      allSessions.sort((a, b) => {
        const aParticipants = participantsBySessionIdForSort[a.id]?.length ?? 0
        const bParticipants = participantsBySessionIdForSort[b.id]?.length ?? 0
        return bParticipants - aParticipants
      })
    } else {
      allSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    }

    const activeSessions = allSessions.filter((s) => s.endedAt === null)
    const endedSessions = allSessions.filter((s) => s.endedAt !== null)

    const sessionIds = allSessions.map((s) => s.id)

    // Resolve entity labels (channel names, DM participant names)
    const entityLabelsMap: Record<string, string | null> = {}

    const channelSessions = allSessions.filter(
      (s) => s.entityType === 'channel',
    )
    const dmSessions = allSessions.filter((s) => s.entityType === 'dm')

    if (channelSessions.length > 0) {
      const channelIds = [...new Set(channelSessions.map((s) => s.entityId))]
      const channelRows = await this.db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(inArray(channels.id, channelIds))
      for (const row of channelRows) {
        entityLabelsMap[`channel:${row.id}`] = row.name?.trim() || null
      }
    }

    if (dmSessions.length > 0) {
      const dmIds = [...new Set(dmSessions.map((s) => s.entityId))]
      const dmRows = await this.db
        .select({
          conversationId: directMessageConversations.id,
          memberUserId: conversationMembers.userId,
          memberDisplayName: workspaceMembers.displayName,
          memberName: workspaceMembers.name,
        })
        .from(directMessageConversations)
        .leftJoin(
          conversationMembers,
          eq(conversationMembers.conversationId, directMessageConversations.id),
        )
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.userId, conversationMembers.userId),
            eq(
              workspaceMembers.workspaceId,
              directMessageConversations.workspaceId,
            ),
          ),
        )
        .where(inArray(directMessageConversations.id, dmIds))

      // For each DM, get the first participant's name
      const dmLabelCandidates: Record<string, string | null> = {}
      for (const row of dmRows) {
        if (!row.conversationId) continue
        const key = `dm:${row.conversationId}`
        if (!dmLabelCandidates[key]) {
          const name =
            row.memberDisplayName?.trim() || row.memberName?.trim() || null
          dmLabelCandidates[key] = name
        }
      }

      for (const [key, label] of Object.entries(dmLabelCandidates)) {
        entityLabelsMap[key] = label
      }
    }

    const replyCountsMap: Record<string, number> = {}

    if (sessionIds.length > 0) {
      const messagesWithSession = await this.db
        .select({
          huddleSessionId: messages.huddleSessionId,
        })
        .from(messages)
        .where(
          and(
            inArray(messages.huddleSessionId, sessionIds),
            isNotNull(messages.parentId), // Only count replies, not feed message
          ),
        )

      for (const msg of messagesWithSession) {
        if (msg.huddleSessionId) {
          replyCountsMap[msg.huddleSessionId] =
            (replyCountsMap[msg.huddleSessionId] || 0) + 1
        }
      }
    }

    // Get feed message IDs for each session
    const feedMessageIdsMap: Record<string, string> = {}
    if (sessionIds.length > 0) {
      const feedMessageRows = await this.findHuddleFeedMessages(sessionIds)
      for (const row of feedMessageRows) {
        if (row.huddleSessionId) {
          feedMessageIdsMap[row.huddleSessionId] = row.id
        }
      }
    }

    const participantRows = await this.findParticipants(sessionIds)
    const participantsBySessionId = participantRows.reduce<
      Record<string, HuddleParticipantDisplayRow[]>
    >((acc, participant) => {
      if (!acc[participant.sessionId]) acc[participant.sessionId] = []
      acc[participant.sessionId].push(participant)
      return acc
    }, {})

    const normalizeToPageItem = (
      session: (typeof allSessions)[0],
    ): {
      id: string
      workspaceId: string
      entityType: 'channel' | 'dm'
      entityId: string
      entityLabel: string | null
      status: 'active' | 'ended'
      topic: string | null
      startedAt: string
      endedAt: string | null
      durationSeconds: number
      participantCount: number
      replyCount: number
      feedMessageId: string | null
      participants: HuddleParticipantSnapshot[]
    } => {
      const participants =
        (participantsBySessionId[session.id] ?? []).map((p) =>
          this.normalizeParticipant(p),
        ) ?? []

      const durationSeconds = session.endedAt
        ? Math.floor(
            (session.endedAt.getTime() - session.startedAt.getTime()) / 1000,
          )
        : Math.floor((now.getTime() - session.startedAt.getTime()) / 1000)

      const key = `${session.entityType}:${session.entityId}`
      const entityLabel = entityLabelsMap[key] ?? null

      return {
        id: session.id,
        workspaceId: session.workspaceId,
        entityType: session.entityType,
        entityId: session.entityId,
        entityLabel,
        status: session.endedAt === null ? 'active' : 'ended',
        topic: session.topic ?? null,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        durationSeconds,
        participantCount: participants.length,
        replyCount: replyCountsMap[session.id] || 0,
        feedMessageId: feedMessageIdsMap[session.id] ?? null,
        participants,
      }
    }

    const paginatedActive = activeSessions.slice(0, pageSize)
    const paginatedRecent = endedSessions.slice(
      (page - 1) * pageSize,
      page * pageSize,
    )

    return {
      active: paginatedActive.map(normalizeToPageItem),
      recent: paginatedRecent.map(normalizeToPageItem),
      pagination: {
        page,
        pageSize,
        totalActive: activeSessions.length,
        totalRecent: endedSessions.length,
      },
    }
  }

  async getRecentHuddles(
    workspaceId: string,
    userId: string,
    filters: {
      type: 'all' | 'missed'
      filter_entityTypes?: 'all' | 'channel' | 'dm'
      filter_channelIds?: string[]
      filter_conversationIds?: string[]
      filter_participantIds?: string[]
      sort?: 'recent' | 'participants'
      page?: number
      pageSize?: number
    },
  ) {
    const {
      type = 'all',
      filter_entityTypes = 'all',
      filter_channelIds,
      filter_conversationIds,
      filter_participantIds,
      sort = 'recent',
      page = 1,
      pageSize = 20,
    } = filters

    const now = new Date()

    // Only ended huddles (endedAt is NOT null, entityActiveKey is null)
    let whereCondition: ReturnType<typeof and> = and(
      eq(huddleSessions.workspaceId, workspaceId),
      isNotNull(huddleSessions.endedAt),
      isNull(huddleSessions.entityActiveKey),
    )

    if (filter_entityTypes === 'channel') {
      whereCondition = and(
        whereCondition,
        eq(huddleSessions.entityType, 'channel'),
      )
    } else if (filter_entityTypes === 'dm') {
      whereCondition = and(whereCondition, eq(huddleSessions.entityType, 'dm'))
    }

    // Build entity filter condition using OR when both channel and dm filters are present
    // "In" filter means: huddle must belong to ANY of the selected channels/dms
    const channelCondition =
      filter_channelIds && filter_channelIds.length > 0
        ? and(
            eq(huddleSessions.entityType, 'channel'),
            inArray(huddleSessions.entityId, filter_channelIds),
          )
        : null

    const dmCondition =
      filter_conversationIds && filter_conversationIds.length > 0
        ? and(
            eq(huddleSessions.entityType, 'dm'),
            inArray(huddleSessions.entityId, filter_conversationIds),
          )
        : null

    if (channelCondition && dmCondition) {
      // Both filters present: use OR
      whereCondition = and(whereCondition, or(channelCondition, dmCondition))
    } else if (channelCondition) {
      whereCondition = and(whereCondition, channelCondition)
    } else if (dmCondition) {
      whereCondition = and(whereCondition, dmCondition)
    }

    let allSessions = await this.db
      .select()
      .from(huddleSessions)
      .where(whereCondition)

    // For 'all' type: show all ended huddles
    // For 'missed' type: show ended huddles user did NOT attend
    if (type === 'missed' && userId) {
      const userParticipantSessions = await this.db
        .select({ sessionId: huddleParticipants.sessionId })
        .from(huddleParticipants)
        .where(eq(huddleParticipants.userId, userId))

      const attendedSet = new Set(
        userParticipantSessions.map((p) => p.sessionId),
      )
      allSessions = allSessions.filter(
        (session) => !attendedSet.has(session.id),
      )
    }

    // Participant filter only for 'all' type (for 'missed', it doesn't make sense to filter by participant)
    // "With" filter: ALL selected users must be participants in the huddle
    if (
      type === 'all' &&
      filter_participantIds &&
      filter_participantIds.length > 0
    ) {
      const participantSessionIds = await this.db
        .select({
          sessionId: huddleParticipants.sessionId,
          userId: huddleParticipants.userId,
        })
        .from(huddleParticipants)
        .where(inArray(huddleParticipants.userId, filter_participantIds))

      // Group by sessionId and count unique users per session
      const userCountPerSession = new Map<string, Set<string>>()
      for (const row of participantSessionIds) {
        if (!userCountPerSession.has(row.sessionId)) {
          userCountPerSession.set(row.sessionId, new Set())
        }
        userCountPerSession.get(row.sessionId)!.add(row.userId)
      }

      // Keep only sessions where ALL selected users are participants
      allSessions = allSessions.filter((session) => {
        const usersInSession = userCountPerSession.get(session.id)
        if (!usersInSession) return false
        return filter_participantIds.every((userId) =>
          usersInSession.has(userId),
        )
      })
    }

    // Sort
    if (sort === 'participants') {
      const sessionIdsForSort = allSessions.map((s) => s.id)
      const participantRowsForSort =
        await this.findParticipants(sessionIdsForSort)
      const participantsBySessionIdForSort = participantRowsForSort.reduce<
        Record<string, HuddleParticipantDisplayRow[]>
      >((acc, participant) => {
        if (!acc[participant.sessionId]) acc[participant.sessionId] = []
        acc[participant.sessionId].push(participant)
        return acc
      }, {})

      allSessions.sort((a, b) => {
        const aParticipants = participantsBySessionIdForSort[a.id]?.length ?? 0
        const bParticipants = participantsBySessionIdForSort[b.id]?.length ?? 0
        return bParticipants - aParticipants
      })
    } else {
      allSessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    }

    const sessionIds = allSessions.map((s) => s.id)

    // Resolve entity labels
    const entityLabelsMap: Record<string, string | null> = {}

    const channelSessions = allSessions.filter(
      (s) => s.entityType === 'channel',
    )
    const dmSessions = allSessions.filter((s) => s.entityType === 'dm')

    if (channelSessions.length > 0) {
      const channelIds = [...new Set(channelSessions.map((s) => s.entityId))]
      const channelRows = await this.db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(inArray(channels.id, channelIds))
      for (const row of channelRows) {
        entityLabelsMap[`channel:${row.id}`] = row.name?.trim() || null
      }
    }

    if (dmSessions.length > 0) {
      const dmIds = [...new Set(dmSessions.map((s) => s.entityId))]
      const dmRows = await this.db
        .select({
          conversationId: directMessageConversations.id,
          memberUserId: conversationMembers.userId,
          memberDisplayName: workspaceMembers.displayName,
          memberName: workspaceMembers.name,
        })
        .from(directMessageConversations)
        .leftJoin(
          conversationMembers,
          eq(conversationMembers.conversationId, directMessageConversations.id),
        )
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.userId, conversationMembers.userId),
            eq(
              workspaceMembers.workspaceId,
              directMessageConversations.workspaceId,
            ),
          ),
        )
        .where(inArray(directMessageConversations.id, dmIds))

      const dmLabelCandidates: Record<string, string | null> = {}
      for (const row of dmRows) {
        if (!row.conversationId) continue
        const key = `dm:${row.conversationId}`
        if (!dmLabelCandidates[key]) {
          const name =
            row.memberDisplayName?.trim() || row.memberName?.trim() || null
          dmLabelCandidates[key] = name
        }
      }

      for (const [key, label] of Object.entries(dmLabelCandidates)) {
        entityLabelsMap[key] = label
      }
    }

    const replyCountsMap: Record<string, number> = {}

    if (sessionIds.length > 0) {
      const messagesWithSession = await this.db
        .select({
          huddleSessionId: messages.huddleSessionId,
        })
        .from(messages)
        .where(
          and(
            inArray(messages.huddleSessionId, sessionIds),
            isNotNull(messages.parentId), // Only count replies, not feed message
          ),
        )

      for (const msg of messagesWithSession) {
        if (msg.huddleSessionId) {
          replyCountsMap[msg.huddleSessionId] =
            (replyCountsMap[msg.huddleSessionId] || 0) + 1
        }
      }
    }

    // Get feed message IDs for each session
    const feedMessageIdsMap: Record<string, string> = {}
    if (sessionIds.length > 0) {
      const feedMessageRows = await this.findHuddleFeedMessages(sessionIds)
      for (const row of feedMessageRows) {
        if (row.huddleSessionId) {
          feedMessageIdsMap[row.huddleSessionId] = row.id
        }
      }
    }

    const participantRows = await this.findParticipants(sessionIds)
    const participantsBySessionId = participantRows.reduce<
      Record<string, HuddleParticipantDisplayRow[]>
    >((acc, participant) => {
      if (!acc[participant.sessionId]) acc[participant.sessionId] = []
      acc[participant.sessionId].push(participant)
      return acc
    }, {})

    const normalizeToPageItem = (
      session: (typeof allSessions)[0],
    ): {
      id: string
      workspaceId: string
      entityType: 'channel' | 'dm'
      entityId: string
      entityLabel: string | null
      status: 'active' | 'ended'
      topic: string | null
      startedAt: string
      endedAt: string | null
      durationSeconds: number
      participantCount: number
      replyCount: number
      feedMessageId: string | null
      participants: HuddleParticipantSnapshot[]
    } => {
      const participants =
        (participantsBySessionId[session.id] ?? []).map((p) =>
          this.normalizeParticipant(p),
        ) ?? []

      const durationSeconds = session.endedAt
        ? Math.floor(
            (session.endedAt.getTime() - session.startedAt.getTime()) / 1000,
          )
        : 0

      const key = `${session.entityType}:${session.entityId}`
      const entityLabel = entityLabelsMap[key] ?? null

      return {
        id: session.id,
        workspaceId: session.workspaceId,
        entityType: session.entityType,
        entityId: session.entityId,
        entityLabel,
        status: 'ended',
        topic: session.topic ?? null,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        durationSeconds,
        participantCount: participants.length,
        replyCount: replyCountsMap[session.id] || 0,
        feedMessageId: feedMessageIdsMap[session.id] ?? null,
        participants,
      }
    }

    const totalRecent = allSessions.length
    const paginatedRecent = allSessions.slice(
      (page - 1) * pageSize,
      page * pageSize,
    )

    return {
      recent: paginatedRecent.map(normalizeToPageItem),
      pagination: {
        page,
        pageSize,
        totalRecent,
      },
    }
  }

  async getWeeklyHuddles(
    workspaceId: string,
    userId: string,
    pageSize: number = 6,
  ) {
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // Get all huddle sessions the user participated in within the last 7 days
    const userParticipations = await this.db
      .select({
        sessionId: huddleParticipants.sessionId,
        sessionWorkspaceId: huddleSessions.workspaceId,
        sessionEntityType: huddleSessions.entityType,
        sessionEntityId: huddleSessions.entityId,
        sessionEndedAt: huddleSessions.endedAt,
      })
      .from(huddleParticipants)
      .innerJoin(
        huddleSessions,
        eq(huddleSessions.id, huddleParticipants.sessionId),
      )
      .where(
        and(
          eq(huddleParticipants.userId, userId),
          eq(huddleSessions.workspaceId, workspaceId),
          isNotNull(huddleSessions.endedAt),
          // Only include sessions ended within the last 7 days
          // endedAt is stored as Date, we need to compare with sevenDaysAgo
          // Note: This assumes huddleSessions.endedAt is a Date object
          // We filter in JS since Drizzle handles Date comparisons
        ),
      )

    // Filter in JS to handle the 7-day window properly
    const recentParticipations = userParticipations.filter((p) => {
      if (!p.sessionEndedAt) return false
      return p.sessionEndedAt.getTime() >= sevenDaysAgo.getTime()
    })

    // Group by entity (entityType + entityId)
    const entityCountMap = new Map<
      string,
      {
        entityType: 'channel' | 'dm'
        entityId: string
        count: number
      }
    >()

    for (const p of recentParticipations) {
      const key = `${p.sessionEntityType}:${p.sessionEntityId}`
      const existing = entityCountMap.get(key)
      if (existing) {
        existing.count++
      } else {
        entityCountMap.set(key, {
          entityType: p.sessionEntityType,
          entityId: p.sessionEntityId,
          count: 1,
        })
      }
    }

    // Sort by count descending and take top N
    const sortedEntities = Array.from(entityCountMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, pageSize)

    if (sortedEntities.length === 0) {
      return { weekly: [] }
    }

    // Resolve entity labels
    const entityLabelsMap: Record<string, string | null> = {}

    const channelEntities = sortedEntities.filter(
      (e) => e.entityType === 'channel',
    )
    const dmEntities = sortedEntities.filter((e) => e.entityType === 'dm')

    if (channelEntities.length > 0) {
      const channelIds = channelEntities.map((e) => e.entityId)
      const channelRows = await this.db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(inArray(channels.id, channelIds))
      for (const row of channelRows) {
        entityLabelsMap[`channel:${row.id}`] = row.name?.trim() || null
      }
    }

    if (dmEntities.length > 0) {
      const dmIds = dmEntities.map((e) => e.entityId)
      const dmRows = await this.db
        .select({
          conversationId: directMessageConversations.id,
          memberDisplayName: workspaceMembers.displayName,
          memberName: workspaceMembers.name,
        })
        .from(directMessageConversations)
        .leftJoin(
          conversationMembers,
          eq(conversationMembers.conversationId, directMessageConversations.id),
        )
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.userId, conversationMembers.userId),
            eq(
              workspaceMembers.workspaceId,
              directMessageConversations.workspaceId,
            ),
          ),
        )
        .where(inArray(directMessageConversations.id, dmIds))

      // For each DM, get the first participant's name (excluding current user would be better but this matches existing pattern)
      const dmLabelCandidates: Record<string, string | null> = {}
      for (const row of dmRows) {
        if (!row.conversationId) continue
        const key = `dm:${row.conversationId}`
        if (!dmLabelCandidates[key]) {
          const name =
            row.memberDisplayName?.trim() || row.memberName?.trim() || null
          dmLabelCandidates[key] = name
        }
      }

      for (const [key, label] of Object.entries(dmLabelCandidates)) {
        entityLabelsMap[key] = label
      }
    }

    // Build final response
    const weekly = sortedEntities.map((entity) => {
      const key = `${entity.entityType}:${entity.entityId}`
      return {
        entityType: entity.entityType,
        entityId: entity.entityId,
        entityLabel: entityLabelsMap[key] ?? null,
        huddleCount: entity.count,
      }
    })

    return { weekly }
  }
}
