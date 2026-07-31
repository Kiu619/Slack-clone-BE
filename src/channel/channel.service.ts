import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, asc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { MessageService } from '../message/message.service'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
import { UnifiedBroadcastService } from '../chat/unified-broadcast.service'
import {
  channels,
  channelMembers,
  workspaceMembers,
  users,
} from '../database/schema'
import { WorkspacePermissionsService } from '../workspace/workspace-permissions.service'
import type { CreateChannelDto } from './dto/create-channel.dto'
import type { UpdateChannelDto } from './dto/update-channel.dto'

@Injectable()
export class ChannelService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly messageService: MessageService,
    private readonly chatBroadcastService: ChatBroadcastService,
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
    private readonly permissionsService: WorkspacePermissionsService,
  ) {}

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_]/g, '')
  }

  /**
   * Tên kênh hợp lệ (CreateChannelDto) từ slug workspace: cùng quy tắc slugify,
   * tối thiểu 2 ký tự (fallback "general").
   */
  channelNameFromWorkspaceSlug(workspaceSlug: string): string {
    let n = this.slugify(workspaceSlug)
    if (n.length < 2) {
      n = 'general'
    }
    return n.slice(0, 80)
  }

  private async assertMembership(workspaceId: string, userId: string) {
    const [member] = await this.db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        membershipStatus: workspaceMembers.membershipStatus,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)

    if (!member) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
    if (member.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }
    return member
  }

  async create(workspaceId: string, userId: string, dto: CreateChannelDto) {
    await this.assertMembership(workspaceId, userId)
    if (dto.isPrivate) {
      await this.permissionsService.requireUserPermission(
        workspaceId,
        userId,
        'create_private_channels',
      )
    } else {
      await this.permissionsService.requireUserPermission(
        workspaceId,
        userId,
        'create_public_channels',
      )
    }

    const slug = this.slugify(dto.name)

    const [existing] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(eq(channels.workspaceId, workspaceId), eq(channels.slug, slug)),
      )
      .limit(1)

    if (existing) {
      throw new ConflictException(
        'A channel with this name already exists in this workspace.',
      )
    }

    const [countRow] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(channels)
      .where(eq(channels.workspaceId, workspaceId))

    const isFirstChannelInWorkspace = (countRow?.n ?? 0) === 0

    const [channel] = await this.db
      .insert(channels)
      .values({
        id: randomUUID(),
        workspaceId,
        name: dto.name,
        slug,
        type: dto.type ?? 'text',
        isPrivate: dto.isPrivate ?? false,
        isDefaultChannel: isFirstChannelInWorkspace,
        description: dto.description ?? null,
        createdById: userId,
      })
      .returning()

    // Người tạo luôn là thành viên channel (owner) — cả public và private.
    await this.db.insert(channelMembers).values({
      id: randomUUID(),
      channelId: channel.id,
      userId,
      role: 'owner',
    })

    return { ...channel, starredAt: null as Date | null }
  }

  async update(
    channelId: string,
    workspaceId: string,
    userId: string,
    dto: UpdateChannelDto,
  ) {
    await this.assertMembership(workspaceId, userId)
    const channel = await this.findOne(channelId, workspaceId, userId)
    const hasSettingsUpdate = dto.postingSettings !== undefined
    const hasPrivacyUpdate = dto.isPrivate !== undefined

    if (hasSettingsUpdate) {
      await this.permissionsService.requireUserPermission(
        workspaceId,
        userId,
        'edit_channel_posting_permissions',
      )
    }

    if (hasPrivacyUpdate && dto.isPrivate !== channel.isPrivate) {
      await this.permissionsService.requireUserPermission(
        workspaceId,
        userId,
        dto.isPrivate
          ? 'convert_public_channels_to_private'
          : 'convert_private_channels_to_public',
      )
    }

    const patch: {
      name?: string
      slug?: string
      topic?: string | null
      description?: string | null
      postingSettings?: UpdateChannelDto['postingSettings']
      isPrivate?: boolean
    } = {}

    if (dto.name !== undefined) {
      const slug = this.slugify(dto.name)
      const [slugConflict] = await this.db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, workspaceId),
            eq(channels.slug, slug),
            ne(channels.id, channelId),
          ),
        )
        .limit(1)
      if (slugConflict) {
        throw new ConflictException(
          'A channel with this name already exists in this workspace.',
        )
      }
      patch.name = dto.name
      patch.slug = slug
    }

    if (dto.topic !== undefined) {
      patch.topic = dto.topic
    }
    if (dto.description !== undefined) {
      patch.description = dto.description
    }
    if (dto.isPrivate !== undefined) {
      patch.isPrivate = dto.isPrivate
    }
    if (dto.postingSettings !== undefined) {
      if (dto.postingSettings === null) {
        patch.postingSettings = null
      } else {
        const normalizedSpecificUserIds =
          dto.postingSettings.mode === 'admins_plus_specific_people'
            ? Array.from(new Set(dto.postingSettings.specificUserIds))
            : []

        patch.postingSettings = {
          mode: dto.postingSettings.mode,
          allowThreads: dto.postingSettings.allowThreads,
          allowMentions: dto.postingSettings.allowMentions,
          specificUserIds: normalizedSpecificUserIds,
        }
      }
    }

    if (Object.keys(patch).length === 0) {
      return channel
    }

    const keepStarredAt = channel.starredAt ?? null

    const [updated] = await this.db
      .update(channels)
      .set(patch)
      .where(eq(channels.id, channelId))
      .returning()

    const result = updated ?? channel
    const norm = (v: string | null | undefined) =>
      v == null || String(v).trim() === '' ? null : String(v).trim()

    const topicChanged =
      dto.topic !== undefined && norm(channel.topic) !== norm(result.topic)
    const descriptionChanged =
      dto.description !== undefined &&
      norm(channel.description) !== norm(result.description)
    const postingSettingsChanged =
      dto.postingSettings !== undefined &&
      JSON.stringify(channel.postingSettings ?? null) !==
        JSON.stringify(result.postingSettings ?? null)
    const privacyChanged =
      dto.isPrivate !== undefined && channel.isPrivate !== result.isPrivate

    const room = `channel:${channelId}`
    if (topicChanged) {
      const m = await this.messageService.createTimelineTextMessage(
        { channelId },
        userId,
        'channel_topic',
        result.topic ?? null,
      )
      this.chatBroadcastService.broadcastMessage(room, m, undefined)
    }
    if (descriptionChanged) {
      const m = await this.messageService.createTimelineTextMessage(
        { channelId },
        userId,
        'channel_description',
        result.description ?? null,
      )
      this.chatBroadcastService.broadcastMessage(room, m, undefined)
    }
    if (postingSettingsChanged) {
      const m = await this.messageService.createTimelineTextMessage(
        { channelId },
        userId,
        'channel_posting_permissions',
      )
      this.chatBroadcastService.broadcastMessage(room, m, undefined)
    }
    if (privacyChanged) {
      const m = await this.messageService.createTimelineTextMessage(
        { channelId },
        userId,
        'channel_privacy',
        result.isPrivate ? 'private' : 'public',
      )
      this.chatBroadcastService.broadcastMessage(room, m, undefined)
    }

    return { ...result, starredAt: keepStarredAt }
  }

  async findAllByWorkspace(
    workspaceId: string,
    userId: string,
    withUserIds: string[] = [],
  ) {
    await this.assertMembership(workspaceId, userId)

    const normalizedWithUserIds = Array.from(
      new Set(
        withUserIds
          .map((id) => id.trim())
          .filter((id) => id.length > 0 && id !== userId),
      ),
    )
    const requiredUserIds =
      normalizedWithUserIds.length > 0
        ? [userId, ...normalizedWithUserIds]
        : [userId]

    let requiredChannelIds: string[] | null = null
    if (normalizedWithUserIds.length > 0) {
      const matchingRows = await this.db
        .select({ channelId: channelMembers.channelId })
        .from(channelMembers)
        .innerJoin(channels, eq(channelMembers.channelId, channels.id))
        .where(
          and(
            eq(channels.workspaceId, workspaceId),
            inArray(channelMembers.userId, requiredUserIds),
          ),
        )
        .groupBy(channelMembers.channelId)
        .having(
          sql`count(distinct ${channelMembers.userId}) = ${requiredUserIds.length}`,
        )

      requiredChannelIds = matchingRows.map((row) => row.channelId)
      if (requiredChannelIds.length === 0) {
        return []
      }
    }

    const rows = await this.db
      .select({
        channel: channels,
        starredAt: channelMembers.starredAt,
      })
      .from(channelMembers)
      .innerJoin(channels, eq(channelMembers.channelId, channels.id))
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channelMembers.userId, userId),
          requiredChannelIds
            ? inArray(channels.id, requiredChannelIds)
            : sql`true`,
        ),
      )

    return rows
      .map((r) => ({
        ...r.channel,
        starredAt: r.starredAt ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async findOne(channelId: string, workspaceId: string, userId: string) {
    await this.assertMembership(workspaceId, userId)

    const [channel] = await this.db
      .select()
      .from(channels)
      .where(
        and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
      )
      .limit(1)

    if (!channel) {
      throw new NotFoundException('Channel not found')
    }

    const [membership] = await this.db
      .select({ id: channelMembers.id, starredAt: channelMembers.starredAt })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, userId),
        ),
      )
      .limit(1)

    if (!membership && channel.isPrivate) {
      throw new ForbiddenException(
        'You are not a member of this private channel',
      )
    }

    return {
      ...channel,
      starredAt: membership?.starredAt ?? null,
    }
  }

  /**
   * Thêm user vào channel mặc định của workspace (khi join workspace, v.v.).
   */
  async ensureMembershipInDefaultChannel(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const [def] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.isDefaultChannel, true),
        ),
      )
      .limit(1)

    if (!def) return

    const [exists] = await this.db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, def.id),
          eq(channelMembers.userId, userId),
        ),
      )
      .limit(1)

    if (exists) return

    await this.db.insert(channelMembers).values({
      id: randomUUID(),
      channelId: def.id,
      userId,
      role: 'member',
    })
  }

  async delete(channelId: string, workspaceId: string, userId: string) {
    await this.assertMembership(workspaceId, userId)
    await this.permissionsService.requireUserPermission(
      workspaceId,
      userId,
      'delete_channels',
    )

    const [channel] = await this.db
      .select({ id: channels.id, isDefaultChannel: channels.isDefaultChannel })
      .from(channels)
      .where(
        and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
      )
      .limit(1)

    if (!channel) {
      throw new NotFoundException('Channel not found')
    }

    if (channel.isDefaultChannel) {
      throw new ForbiddenException('The default channel cannot be deleted')
    }

    await this.db.delete(channels).where(eq(channels.id, channelId))

    return { message: 'Channel deleted successfully' }
  }

  /** ILIKE pattern an toàn: escape % và _ cho PostgreSQL LIKE. */
  private ilikeSearchPattern(raw: string): string {
    const t = raw.trim()
    if (!t) return '%'
    const escaped = t
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
    return `%${escaped}%`
  }

  private memberSearchFilter(search?: string) {
    const q = search?.trim()
    if (!q) return undefined
    const p = this.ilikeSearchPattern(q)
    return or(
      ilike(users.email, p),
      ilike(users.name, p),
      ilike(workspaceMembers.name, p),
      ilike(workspaceMembers.displayName, p),
    )
  }

  private memberSelectFields(
    joinedAtCol:
      | typeof channelMembers.joinedAt
      | typeof workspaceMembers.joinedAt,
  ) {
    return {
      id: users.id,
      name: sql<
        string | null
      >`COALESCE(${workspaceMembers.name}, ${users.name})`,
      displayName: sql<
        string | null
      >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
      email: users.email,
      avatar: sql<
        string | null
      >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
      isAway: workspaceMembers.isAway,
      statusEmoji: workspaceMembers.statusEmoji,
      statusText: workspaceMembers.statusText,
      joinedAt: joinedAtCol,
    }
  }

  async getMemberStatus(
    channelId: string,
    workspaceId: string,
    userId: string,
  ) {
    await this.assertMembership(workspaceId, userId)
    const [viewerMembership] = await this.db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, userId),
        ),
      )
      .limit(1)

    if (!viewerMembership) {
      return {
        isMember: false,
      }
    }

    return {
      isMember: true,
    }
  }

  /**
   * Members tab: `inChannel` luôn trả về; `notInChannel` chỉ khi có `search` (tiết kiệm query).
   * Mọi channel (kể cả default): chỉ dựa trên `channel_members`.
   */
  async getMembers(
    channelId: string,
    workspaceId: string,
    userId: string,
    search?: string,
  ) {
    await this.assertMembership(workspaceId, userId)

    const [channel] = await this.db
      .select({ id: channels.id, isPrivate: channels.isPrivate })
      .from(channels)
      .where(
        and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
      )
      .limit(1)

    if (!channel) throw new NotFoundException('Channel not found')

    const [viewerMembership] = await this.db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, userId),
        ),
      )
      .limit(1)

    if (!viewerMembership && channel.isPrivate) {
      throw new ForbiddenException('You are not a member of this channel')
    }

    const searchCond = this.memberSearchFilter(search)

    const inWhere = searchCond
      ? and(eq(channelMembers.channelId, channelId), searchCond)
      : eq(channelMembers.channelId, channelId)

    const inChannel = await this.db
      .select(this.memberSelectFields(channelMembers.joinedAt))
      .from(channelMembers)
      .innerJoin(users, eq(channelMembers.userId, users.id))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .where(inWhere)
      .orderBy(asc(users.name), asc(users.email))

    if (!searchCond) {
      return { inChannel, notInChannel: [] as typeof inChannel }
    }

    const notWhere = and(
      eq(workspaceMembers.workspaceId, workspaceId),
      isNull(channelMembers.id),
      searchCond,
    )

    const notInChannel = await this.db
      .select(this.memberSelectFields(workspaceMembers.joinedAt))
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .leftJoin(
        channelMembers,
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, workspaceMembers.userId),
        ),
      )
      .where(notWhere)
      .orderBy(asc(users.name), asc(users.email))

    return { inChannel, notInChannel }
  }

  async addChannelMember(
    channelId: string,
    workspaceId: string,
    requesterId: string,
    targetUserId: string,
  ) {
    await this.findOne(channelId, workspaceId, requesterId)
    await this.permissionsService.requireUserPermission(
      workspaceId,
      requesterId,
      'manage_user_permissions',
    )

    const [targetWs] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1)

    if (!targetWs) {
      throw new NotFoundException('User is not a member of this workspace')
    }

    const [existing] = await this.db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, targetUserId),
        ),
      )
      .limit(1)

    if (existing) {
      throw new ConflictException('User is already in this channel')
    }

    await this.db.insert(channelMembers).values({
      id: randomUUID(),
      channelId,
      userId: targetUserId,
      role: 'member',
    })

    return { ok: true as const }
  }

  /**
   * Thêm mọi workspace member chưa có trong channel (không dùng cho default channel — UI dùng tìm từng người).
   */
  async addAllWorkspaceMembersToChannel(
    channelId: string,
    workspaceId: string,
    requesterId: string,
  ): Promise<{ added: number; addedUserIds: string[] }> {
    await this.findOne(channelId, workspaceId, requesterId)
    await this.permissionsService.requireUserPermission(
      workspaceId,
      requesterId,
      'manage_user_permissions',
    )

    const [ch] = await this.db
      .select({
        isDefaultChannel: channels.isDefaultChannel,
        isPrivate: channels.isPrivate,
      })
      .from(channels)
      .where(
        and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
      )
      .limit(1)

    if (!ch) throw new NotFoundException('Channel not found')
    if (ch.isDefaultChannel) {
      throw new ForbiddenException(
        'Bulk add is not available for the default channel',
      )
    }

    const wsMembers = await this.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))

    const existing = await this.db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channelId))

    const existingSet = new Set(existing.map((r) => r.userId))
    const toAdd = wsMembers.filter((w) => !existingSet.has(w.userId))

    if (toAdd.length === 0) {
      return { added: 0, addedUserIds: [] }
    }

    await this.db.insert(channelMembers).values(
      toAdd.map((w) => ({
        id: randomUUID(),
        channelId,
        userId: w.userId,
        role: 'member' as const,
      })),
    )

    return {
      added: toAdd.length,
      addedUserIds: toAdd.map((w) => w.userId),
    }
  }

  async removeChannelMember(
    channelId: string,
    workspaceId: string,
    requesterId: string,
    targetUserId: string,
  ) {
    await this.assertMembership(workspaceId, requesterId)

    const [ch] = await this.db
      .select({
        isDefaultChannel: channels.isDefaultChannel,
        isPrivate: channels.isPrivate,
      })
      .from(channels)
      .where(
        and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
      )
      .limit(1)

    if (!ch) throw new NotFoundException('Channel not found')
    if (ch.isDefaultChannel) {
      throw new ForbiddenException(
        'Cannot remove members from the default channel',
      )
    }

    await this.findOne(channelId, workspaceId, requesterId)

    if (targetUserId !== requesterId) {
      await this.permissionsService.requireUserPermission(
        workspaceId,
        requesterId,
        ch.isPrivate
          ? 'remove_users_from_private_channels'
          : 'remove_users_from_public_channels',
      )
    }

    const [row] = await this.db
      .delete(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, targetUserId),
        ),
      )
      .returning({ id: channelMembers.id })

    if (!row) {
      throw new NotFoundException('User is not in this channel')
    }

    return { ok: true as const }
  }

  private toStarredAtIso(v: Date | string | null | undefined): string | null {
    if (v == null) return null
    if (v instanceof Date) return v.toISOString()
    if (typeof v === 'string') return v
    return null
  }

  private broadcastSidebarStarChannel(
    userId: string,
    workspaceId: string,
    channelId: string,
    starredAt: Date | string | null | undefined,
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcastService.broadcastToUser(
      userId,
      workspaceId,
      'sidebar:star',
      {
        kind: 'channel' as const,
        id: channelId,
        starredAt: this.toStarredAtIso(starredAt),
      },
      excludeSocketId,
    )
  }

  async starChannel(
    channelId: string,
    workspaceId: string,
    userId: string,
    excludeSocketId?: string,
  ) {
    await this.assertMembership(workspaceId, userId)

    const [ch] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
      )
      .limit(1)

    if (!ch) {
      throw new NotFoundException('Channel not found')
    }

    const [mem] = await this.db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, userId),
        ),
      )
      .limit(1)

    if (!mem) {
      throw new ForbiddenException(
        'You must be a member of this channel to star it',
      )
    }

    await this.db
      .update(channelMembers)
      .set({ starredAt: new Date() })
      .where(eq(channelMembers.id, mem.id))

    const updated = await this.findOne(channelId, workspaceId, userId)
    this.broadcastSidebarStarChannel(
      userId,
      workspaceId,
      channelId,
      updated.starredAt,
      excludeSocketId,
    )
    return updated
  }

  async unstarChannel(
    channelId: string,
    workspaceId: string,
    userId: string,
    excludeSocketId?: string,
  ) {
    await this.assertMembership(workspaceId, userId)

    const [ch] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
      )
      .limit(1)

    if (!ch) {
      throw new NotFoundException('Channel not found')
    }

    const [mem] = await this.db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, userId),
        ),
      )
      .limit(1)

    if (mem) {
      await this.db
        .update(channelMembers)
        .set({ starredAt: null })
        .where(eq(channelMembers.id, mem.id))
    }

    const updated = await this.findOne(channelId, workspaceId, userId)
    this.broadcastSidebarStarChannel(
      userId,
      workspaceId,
      channelId,
      updated.starredAt,
      excludeSocketId,
    )
    return updated
  }
}
