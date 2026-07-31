import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { AttachmentService } from '../attachment/attachment.service'
import { MessageService } from '../message/message.service'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
import { UnifiedBroadcastService } from '../chat/unified-broadcast.service'
import {
  directMessageConversations,
  conversationMembers,
  users,
  workspaceMembers,
  messages,
  attachments,
  channelFolders,
  channelNotificationOverrides,
  notifications,
  type DirectMessageConversation,
  Message,
} from '../database/schema'
import {
  and,
  eq,
  inArray,
  sql,
  desc,
  or,
  ilike,
  asc,
  isNull,
  gt,
  ne,
} from 'drizzle-orm'
import { randomUUID } from 'crypto'
import type { CreateDirectMessageDto } from './dto/direct-message.dto'
import type { UpdateConversationDto } from './dto/update-conversation.dto'

const DM_MERGE_BROADCAST_CHUNK_SIZE = 40

type DmConversationMember = {
  id: string
  name: string | null
  avatar: string | null
  displayName: string | null
  email: string
  membershipStatus: 'active' | 'deactivated'
  isAway: boolean | null
  status: string | null
  statusText: string | null
  statusEmoji: string | null
}

export interface ConversationWithMetadata extends DirectMessageConversation {
  members: DmConversationMember[]
  lastMessageUser: {
    id: string
    name: string | null
    displayName: string | null
  } | null
  starredAt: Date | null
  lastReadAt: Date | null
  unreadCount: number
  isArchivedBecausePeerDeactivated?: boolean
}

type DMTransaction = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0]

type ConversationReadState = {
  conversationId: string
  lastReadAt: Date
  unreadCount: number
}

@Injectable()
export class DirectMessageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly attachmentService: AttachmentService,
    private readonly messageService: MessageService,
    private readonly chatBroadcastService: ChatBroadcastService,
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
  ) {}

  /**
   * Tìm conversation trong workspace có đúng tập thành viên (không thừa, không thiếu).
   */
  private async findConversationIdByExactMemberSet(
    workspaceId: string,
    sortedUserIds: string[],
  ): Promise<string | null> {
    const memberCount = sortedUserIds.length
    if (memberCount === 0) return null

    const existingConversation = await this.db.execute(sql`
      SELECT cm.conversation_id
      FROM ${conversationMembers} cm
      JOIN ${directMessageConversations} dc ON dc.id = cm.conversation_id
      WHERE dc.workspace_id = ${workspaceId}
        AND cm.user_id IN (${sql.join(
          sortedUserIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      GROUP BY cm.conversation_id
      HAVING COUNT(DISTINCT cm.user_id) = ${memberCount}
         AND (SELECT COUNT(*) FROM ${conversationMembers} WHERE conversation_id = cm.conversation_id) = ${memberCount}
      LIMIT 1
    `)

    if (existingConversation.length === 0) return null
    const row = existingConversation[0] as { conversation_id: string }
    return row.conversation_id
  }

  private async syncConversationLastMessageFromMessagesTx(
    tx: DMTransaction,
    conversationId: string,
  ) {
    const [latest] = await tx
      .select({
        id: messages.id,
        content: messages.content,
        userId: messages.userId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(1)

    if (!latest) {
      await tx
        .update(directMessageConversations)
        .set({
          lastMessageAt: null,
          lastMessageContent: null,
          lastMessageUserId: null,
          lastMessageId: null,
        })
        .where(eq(directMessageConversations.id, conversationId))
      return
    }

    await tx
      .update(directMessageConversations)
      .set({
        lastMessageAt: latest.createdAt,
        lastMessageContent: latest.content,
        lastMessageUserId: latest.userId,
        lastMessageId: latest.id,
      })
      .where(eq(directMessageConversations.id, conversationId))
  }

  /**
   * Chuyển toàn bộ dữ liệu gắn source sang target; **giữ** hàng `dm_conversations` của source.
   * Trả về danh sách id tin đã chuyển (theo `created_at ASC`) để broadcast realtime sau commit.
   */
  private async mergeDmConversationsTx(
    tx: DMTransaction,
    workspaceId: string,
    sourceId: string,
    targetId: string,
  ): Promise<string[]> {
    const timelineRootCondition = or(
      eq(messages.type, 'timeline'),
      and(
        eq(messages.type, 'text'),
        eq(messages.allowEdit, false),
        isNull(messages.parentId),
      ),
    )

    const timelineRoots = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, sourceId), timelineRootCondition))

    const timelineRootIds = timelineRoots.map((r) => r.id)

    const sourceMessageIdsToDelete = timelineRootIds.length
      ? [
          ...(
            await tx
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.conversationId, sourceId),
                  inArray(messages.parentId, timelineRootIds),
                ),
              )
          ).map((r) => r.id),
          ...timelineRootIds,
        ]
      : []

    if (sourceMessageIdsToDelete.length > 0) {
      const attachmentsToDelete = (await tx
        .select({
          id: attachments.id,
          url: attachments.url,
          type: attachments.type,
        })
        .from(attachments)
        .where(
          inArray(attachments.messageId, sourceMessageIdsToDelete),
        )) as Array<{
        id: string
        url: string
        type: string
      }>

      if (attachmentsToDelete.length > 0) {
        await this.attachmentService.deleteAttachmentStorageBatch(
          attachmentsToDelete,
        )
      }
    }

    if (timelineRootIds.length > 0) {
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.conversationId, sourceId),
            inArray(messages.parentId, timelineRootIds),
          ),
        )
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.conversationId, sourceId),
            inArray(messages.id, timelineRootIds),
          ),
        )
    }

    const idRows = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, sourceId))
      .orderBy(asc(messages.createdAt))

    const movedIds = idRows.map((r) => r.id)

    await tx
      .update(messages)
      .set({ conversationId: targetId })
      .where(eq(messages.conversationId, sourceId))

    await tx
      .update(attachments)
      .set({ conversationId: targetId })
      .where(eq(attachments.conversationId, sourceId))

    const targetFolderRows = await tx
      .select({ name: channelFolders.name })
      .from(channelFolders)
      .where(eq(channelFolders.conversationId, targetId))

    const takenNames = new Set(targetFolderRows.map((r) => r.name))

    const sourceFolders = await tx
      .select()
      .from(channelFolders)
      .where(eq(channelFolders.conversationId, sourceId))

    for (const folder of sourceFolders) {
      let candidate = folder.name
      let n = 0
      while (takenNames.has(candidate)) {
        n += 1
        candidate = `${folder.name} (${n})`
      }
      takenNames.add(candidate)
      await tx
        .update(channelFolders)
        .set({ conversationId: targetId, name: candidate })
        .where(eq(channelFolders.id, folder.id))
    }

    const sourceOverrides = await tx
      .select()
      .from(channelNotificationOverrides)
      .where(
        and(
          eq(channelNotificationOverrides.workspaceId, workspaceId),
          eq(channelNotificationOverrides.conversationId, sourceId),
        ),
      )

    for (const row of sourceOverrides) {
      const [existing] = await tx
        .select({ id: channelNotificationOverrides.id })
        .from(channelNotificationOverrides)
        .where(
          and(
            eq(channelNotificationOverrides.userId, row.userId),
            eq(channelNotificationOverrides.workspaceId, workspaceId),
            eq(channelNotificationOverrides.conversationId, targetId),
          ),
        )
        .limit(1)

      if (existing) {
        await tx
          .delete(channelNotificationOverrides)
          .where(eq(channelNotificationOverrides.id, row.id))
      } else {
        await tx
          .update(channelNotificationOverrides)
          .set({ conversationId: targetId })
          .where(eq(channelNotificationOverrides.id, row.id))
      }
    }

    await tx
      .update(notifications)
      .set({ conversationId: targetId })
      .where(eq(notifications.conversationId, sourceId))

    await this.syncConversationLastMessageFromMessagesTx(tx, targetId)
    await this.syncConversationLastMessageFromMessagesTx(tx, sourceId)

    return movedIds
  }

  private yieldEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
  }

  private async getDmMemberUserIds(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))
    return rows.map((r) => r.userId)
  }

  private async getConversationReadStates(
    workspaceId: string,
    userId: string,
    conversationIds: string[],
  ): Promise<Map<string, ConversationReadState>> {
    if (conversationIds.length === 0) {
      return new Map()
    }

    const rows = await this.db
      .select({
        conversationId: conversationMembers.conversationId,
        lastReadAt: conversationMembers.lastReadAt,
        unreadCount: sql<number>`count(${messages.id})::int`,
      })
      .from(conversationMembers)
      .innerJoin(
        directMessageConversations,
        eq(directMessageConversations.id, conversationMembers.conversationId),
      )
      .leftJoin(
        messages,
        and(
          eq(messages.conversationId, directMessageConversations.id),
          gt(messages.createdAt, conversationMembers.lastReadAt),
          ne(messages.userId, userId),
          isNull(messages.deletedAt),
        ),
      )
      .where(
        and(
          eq(conversationMembers.userId, userId),
          eq(directMessageConversations.workspaceId, workspaceId),
          inArray(conversationMembers.conversationId, conversationIds),
        ),
      )
      .groupBy(
        conversationMembers.conversationId,
        conversationMembers.lastReadAt,
      )

    return new Map(
      rows.map((row) => [
        row.conversationId,
        {
          conversationId: row.conversationId,
          lastReadAt: row.lastReadAt,
          unreadCount: Number(row.unreadCount ?? 0),
        },
      ]),
    )
  }

  /**
   * Sau merge DB: stub DM cũ, timeline DM mới, invalidate cache, broadcast từng tin theo chunk.
   */
  private async afterDmMergeBroadcastRealtime(
    workspaceId: string,
    sourceId: string,
    targetId: string,
    movedIds: string[],
    requesterId: string,
  ) {
    const [targetRecipientIds, sourceRecipientIds] = await Promise.all([
      this.getDmMemberUserIds(targetId),
      this.getDmMemberUserIds(sourceId),
    ])

    await this.messageService.invalidateMessagePage1Caches([sourceId, targetId])

    const mergedOutMsg = await this.messageService.createTimelineTextMessage(
      { conversationId: sourceId },
      requesterId,
      'dm_merged_out',
    )
    this.chatBroadcastService.broadcastMessage(
      `conversation:${sourceId}`,
      mergedOutMsg,
      undefined,
    )

    for (let i = 0; i < movedIds.length; i += DM_MERGE_BROADCAST_CHUNK_SIZE) {
      const chunk = movedIds.slice(i, i + DM_MERGE_BROADCAST_CHUNK_SIZE)
      const byId = await this.messageService.getMessagesByIds(
        chunk,
        requesterId,
      )
      for (const mid of chunk) {
        const m = byId.get(mid) as Message
        if (!m) continue
        const payload = {
          ...m,
          workspaceId,
          conversationId: targetId,
          recipientIds: targetRecipientIds,
        }
        this.chatBroadcastService.broadcastMessage(
          `conversation:${targetId}`,
          payload,
          undefined,
        )
        this.chatBroadcastService.broadcastMessageDeleted(
          `conversation:${sourceId}`,
          mid,
          undefined,
          m.parentId ?? undefined,
          sourceRecipientIds,
          workspaceId,
          targetId,
        )
      }
      await this.yieldEventLoop()
    }

    const mergeMsg = await this.messageService.createTimelineTextMessage(
      { conversationId: targetId },
      requesterId,
      'dm_merge',
    )
    this.chatBroadcastService.broadcastMessage(
      `conversation:${targetId}`,
      mergeMsg,
      undefined,
    )
  }

  /**
   * getOrCreateConversation
   * Tìm hoặc tạo một cuộc hội thoại DM (1-1 hoặc Group)
   */
  async getOrCreateConversation(
    currentUserId: string,
    dto: CreateDirectMessageDto,
  ) {
    const { workspaceId, userIds: otherUserIds } = dto

    // 1. Chuẩn hóa danh sách User IDs: thêm bản thân, unique, sort
    const allUserIds = Array.from(
      new Set([currentUserId, ...otherUserIds]),
    ).sort()
    const memberCount = allUserIds.length

    if (memberCount > 9) {
      throw new BadRequestException('Group DM is limited to 9 members')
    }

    // 2. Kiểm tra xem tất cả user có thuộc workspace không
    const membersInWs = await this.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.membershipStatus, 'active'),
          inArray(workspaceMembers.userId, allUserIds),
        ),
      )

    if (membersInWs.length !== memberCount) {
      throw new BadRequestException(
        'One or more users are not members of this workspace',
      )
    }

    const existingId = await this.findConversationIdByExactMemberSet(
      workspaceId,
      allUserIds,
    )
    if (existingId) {
      return this.getConversationById(existingId, currentUserId, workspaceId)
    }

    // 4. Nếu chưa có, tạo mới
    const isGroup = memberCount > 2
    const conversationId = randomUUID()

    await this.db.transaction(async (tx) => {
      // Tạo conversation
      await tx.insert(directMessageConversations).values({
        id: conversationId,
        workspaceId,
        isGroup,
      })

      // Thêm thành viên
      const memberValues = allUserIds.map((userId) => ({
        id: randomUUID(),
        conversationId,
        userId,
      }))
      await tx.insert(conversationMembers).values(memberValues)
    })

    return this.getConversationById(conversationId, currentUserId, workspaceId)
  }

  private ilikeSearchPattern(raw: string): string {
    const t = raw.trim()
    if (!t) return '%'
    const escaped = t
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
    return `%${escaped}%`
  }

  private dmMemberSearchFilter(search?: string) {
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

  /**
   * getConversationById
   * Lấy thông tin chi tiết cuộc hội thoại kèm danh sách thành viên
   */
  async getConversationById(
    conversationId: string,
    currentUserId: string,
    workspaceId?: string,
  ) {
    const [conversation] = await this.db
      .select()
      .from(directMessageConversations)
      .where(eq(directMessageConversations.id, conversationId))
      .limit(1)

    if (!conversation) {
      throw new NotFoundException('Conversation not found')
    }

    if (workspaceId && conversation.workspaceId !== workspaceId) {
      throw new NotFoundException('Conversation not found')
    }

    // Lấy danh sách thành viên kèm info profile
    const members = await this.db
      .select({
        id: users.id,
        name: sql<
          string | null
        >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated user' ELSE COALESCE(${workspaceMembers.name}, ${users.name}) END`,
        avatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        displayName: sql<
          string | null
        >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated user' ELSE COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name}) END`,
        email: users.email,
        membershipStatus: sql<
          'active' | 'deactivated'
        >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated' ELSE ${workspaceMembers.membershipStatus} END`,
        isAway: workspaceMembers.isAway,
        status: workspaceMembers.statusText,
        statusText: workspaceMembers.statusText,
        statusEmoji: workspaceMembers.statusEmoji,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(conversationMembers.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, conversation.workspaceId),
        ),
      )
      .where(eq(conversationMembers.conversationId, conversationId))

    // Kiểm tra xem currentUserId có phải thành viên không
    if (!members.find((m) => m.id === currentUserId)) {
      throw new BadRequestException('You are not a member of this conversation')
    }

    let lastMessageUser: {
      id: string
      name: string | null
      displayName: string | null
    } | null = null
    if (conversation.lastMessageUserId) {
      const [lmUser] = await this.db
        .select({
          id: users.id,
          name: sql<
            string | null
          >`COALESCE(${workspaceMembers.name}, ${users.name})`,
          displayName: sql<
            string | null
          >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        })
        .from(users)
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.userId, users.id),
            eq(workspaceMembers.workspaceId, conversation.workspaceId),
          ),
        )
        .where(eq(users.id, conversation.lastMessageUserId))
        .limit(1)
      lastMessageUser = lmUser ?? null
    }

    const [selfMembership] = await this.db
      .select({ starredAt: conversationMembers.starredAt })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, currentUserId),
        ),
      )
      .limit(1)

    const readState = await this.getConversationReadStates(
      conversation.workspaceId,
      currentUserId,
      [conversationId],
    )

    const otherMembers = members.filter((m) => m.id !== currentUserId)
    const isArchivedBecausePeerDeactivated =
      !conversation.isGroup &&
      otherMembers.length === 1 &&
      otherMembers[0]?.membershipStatus !== 'active'

    return {
      ...conversation,
      members,
      lastMessageUser,
      starredAt: selfMembership?.starredAt ?? null,
      lastReadAt: readState.get(conversationId)?.lastReadAt ?? null,
      unreadCount: readState.get(conversationId)?.unreadCount ?? 0,
      isArchivedBecausePeerDeactivated,
    }
  }

  /**
   * getConversations
   * Lấy danh sách các cuộc hội thoại DM của user trong một workspace
   */
  async getConversations(workspaceId: string, userId: string, q?: string) {
    // Tìm các conversation IDs mà user tham gia
    const userConversationIdsQuery = this.db
      .select({ conversationId: conversationMembers.conversationId })
      .from(conversationMembers)
      .innerJoin(
        directMessageConversations,
        eq(directMessageConversations.id, conversationMembers.conversationId),
      )
      .where(
        and(
          eq(directMessageConversations.workspaceId, workspaceId),
          eq(conversationMembers.userId, userId),
        ),
      )

    const userConversationIds = await userConversationIdsQuery

    if (userConversationIds.length === 0) return []

    const ids = userConversationIds.map((c) => c.conversationId)

    const starRows = await this.db
      .select({
        conversationId: conversationMembers.conversationId,
        starredAt: conversationMembers.starredAt,
      })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.userId, userId),
          inArray(conversationMembers.conversationId, ids),
        ),
      )

    const starredAtByConversationId = new Map(
      starRows.map((r) => [r.conversationId, r.starredAt]),
    )

    const readStateByConversationId = await this.getConversationReadStates(
      workspaceId,
      userId,
      ids,
    )

    // Lấy full data cho các conversation này, bao gồm cả các members khác
    const conversationsQuery = this.db
      .select()
      .from(directMessageConversations)
      .where(inArray(directMessageConversations.id, ids))

    const conversations = await conversationsQuery.orderBy(
      desc(directMessageConversations.lastMessageAt),
    )

    // Với mỗi conversation, lấy thông tin thành viên
    const result = await Promise.all(
      conversations.map(async (conv) => {
        const members = await this.db
          .select({
            id: users.id,
            name: sql<
              string | null
            >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated user' ELSE COALESCE(${workspaceMembers.name}, ${users.name}) END`,
            avatar: sql<
              string | null
            >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
            displayName: sql<
              string | null
            >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated user' ELSE COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name}) END`,
            email: users.email,
            membershipStatus: sql<
              'active' | 'deactivated'
            >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated' ELSE ${workspaceMembers.membershipStatus} END`,
            isAway: workspaceMembers.isAway,
            status: workspaceMembers.statusText,
            statusText: workspaceMembers.statusText,
            statusEmoji: workspaceMembers.statusEmoji,
          })
          .from(conversationMembers)
          .innerJoin(users, eq(conversationMembers.userId, users.id))
          .leftJoin(
            workspaceMembers,
            and(
              eq(workspaceMembers.userId, users.id),
              eq(workspaceMembers.workspaceId, conv.workspaceId),
            ),
          )
          .where(eq(conversationMembers.conversationId, conv.id))

        // Lấy thông tin user của người gửi tin nhắn cuối
        let lastMessageUser: {
          id: string
          name: string | null
          displayName: string | null
        } | null = null
        if (conv.lastMessageUserId) {
          const [lmUser] = await this.db
            .select({
              id: users.id,
              name: sql<
                string | null
              >`COALESCE(${workspaceMembers.name}, ${users.name})`,
              displayName: sql<
                string | null
              >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
            })
            .from(users)
            .leftJoin(
              workspaceMembers,
              and(
                eq(workspaceMembers.userId, users.id),
                eq(workspaceMembers.workspaceId, conv.workspaceId),
              ),
            )
            .where(eq(users.id, conv.lastMessageUserId))
            .limit(1)
          lastMessageUser = lmUser
        }

        const conversationWithMetadata: ConversationWithMetadata = {
          ...(conv as DirectMessageConversation),
          members,
          lastMessageUser,
          starredAt: starredAtByConversationId.get(conv.id) ?? null,
          lastReadAt:
            readStateByConversationId.get(conv.id)?.lastReadAt ?? null,
          unreadCount: readStateByConversationId.get(conv.id)?.unreadCount ?? 0,
          isArchivedBecausePeerDeactivated:
            !conv.isGroup &&
            members.filter((m) => m.id !== userId).length === 1 &&
            members.find((m) => m.id !== userId)?.membershipStatus !== 'active',
        }
        return conversationWithMetadata
      }),
    )

    // Nếu có query search, lọc kết quả dựa trên members (name, displayName, email) và lastMessageContent
    const visibleResult = result.filter((conv) => {
      if (conv.isGroup) return true
      const otherMembers = conv.members.filter((m) => m.id !== userId)
      if (otherMembers.length === 0) return true
      return otherMembers.every((m) => m.membershipStatus === 'active')
    })

    if (q && q.trim()) {
      const searchLower = q.trim().toLowerCase()
      return visibleResult.filter((conv) => {
        // Search trong members (trừ bản thân nếu là 1-1)
        const memberMatch = conv.members.some((m) => {
          if (m.id === userId && !conv.isGroup) return false
          return (
            m.name?.toLowerCase().includes(searchLower) ||
            m.displayName?.toLowerCase().includes(searchLower) ||
            m.email.toLowerCase().includes(searchLower)
          )
        })

        // Search trong nội dung tin nhắn cuối
        const messageMatch = conv.lastMessageContent
          ?.toLowerCase()
          .includes(searchLower)

        return memberMatch || messageMatch
      })
    }

    return visibleResult
  }

  async updateConversation(
    workspaceId: string,
    conversationId: string,
    userId: string,
    dto: UpdateConversationDto,
  ) {
    await this.getConversationById(conversationId, userId, workspaceId)

    const [prev] = await this.db
      .select({
        topic: directMessageConversations.topic,
        description: directMessageConversations.description,
      })
      .from(directMessageConversations)
      .where(
        and(
          eq(directMessageConversations.id, conversationId),
          eq(directMessageConversations.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    const patch: { topic?: string | null; description?: string | null } = {}
    if (dto.topic !== undefined) patch.topic = dto.topic
    if (dto.description !== undefined) patch.description = dto.description

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('At least one field is required')
    }

    const norm = (v: string | null | undefined) =>
      v == null || String(v).trim() === '' ? null : String(v).trim()

    const topicChanged =
      dto.topic !== undefined && norm(prev?.topic) !== norm(dto.topic)
    const descriptionChanged =
      dto.description !== undefined &&
      norm(prev?.description) !== norm(dto.description)

    await this.db
      .update(directMessageConversations)
      .set(patch)
      .where(
        and(
          eq(directMessageConversations.id, conversationId),
          eq(directMessageConversations.workspaceId, workspaceId),
        ),
      )

    const room = `conversation:${conversationId}`
    if (topicChanged) {
      const m = await this.messageService.createTimelineTextMessage(
        { conversationId },
        userId,
        'dm_topic',
        dto.topic ?? null,
      )
      this.chatBroadcastService.broadcastMessage(room, m, undefined)
    }
    if (descriptionChanged) {
      const m = await this.messageService.createTimelineTextMessage(
        { conversationId },
        userId,
        'dm_description',
        dto.description ?? null,
      )
      this.chatBroadcastService.broadcastMessage(room, m, undefined)
    }

    return this.getConversationById(conversationId, userId, workspaceId)
  }

  /**
   * Thành viên workspace khớp tìm kiếm — kèm cờ đã trong DM (UI: "Already in this conversation").
   */
  async getInviteCandidates(
    workspaceId: string,
    conversationId: string,
    userId: string,
    q?: string,
  ) {
    const [conv] = await this.db
      .select({ id: directMessageConversations.id })
      .from(directMessageConversations)
      .where(
        and(
          eq(directMessageConversations.id, conversationId),
          eq(directMessageConversations.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    if (!conv) throw new NotFoundException('Conversation not found')

    await this.getConversationById(conversationId, userId, workspaceId)

    const searchCond = this.dmMemberSearchFilter(q)
    if (!searchCond) {
      return []
    }

    const leftJoinConv = and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, workspaceMembers.userId),
    )

    const whereBase = [
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.membershipStatus, 'active'),
    ]
    if (searchCond) whereBase.push(searchCond)

    const rowsRaw = await this.db
      .select({
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
        membershipStatus: workspaceMembers.membershipStatus,
        isAway: workspaceMembers.isAway,
        statusEmoji: workspaceMembers.statusEmoji,
        statusText: workspaceMembers.statusText,
        joinedAt: workspaceMembers.joinedAt,
        conversationMemberId: conversationMembers.id,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .leftJoin(conversationMembers, leftJoinConv)
      .where(and(...whereBase))
      .orderBy(asc(users.name), asc(users.email))
      .limit(50)

    return rowsRaw.map(({ conversationMemberId, ...r }) => ({
      ...r,
      inConversation: conversationMemberId != null,
    }))
  }

  async addConversationMembers(
    workspaceId: string,
    conversationId: string,
    requesterId: string,
    userIds: string[],
  ) {
    const unique = Array.from(new Set(userIds))
    if (unique.length === 0) {
      throw new BadRequestException('At least one user is required')
    }

    const [conv] = await this.db
      .select({ id: directMessageConversations.id })
      .from(directMessageConversations)
      .where(
        and(
          eq(directMessageConversations.id, conversationId),
          eq(directMessageConversations.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    if (!conv) throw new NotFoundException('Conversation not found')

    await this.getConversationById(conversationId, requesterId, workspaceId)

    const currentRows = await this.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))

    const currentIds = new Set(currentRows.map((r) => r.userId))
    const currentCount = currentIds.size

    if (currentCount + unique.length > 9) {
      throw new BadRequestException('Group DM is limited to 9 members')
    }

    for (const uid of unique) {
      if (currentIds.has(uid)) {
        throw new ConflictException('User is already in this conversation')
      }
    }

    const wsRows = await this.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.membershipStatus, 'active'),
          inArray(workspaceMembers.userId, unique),
        ),
      )

    if (wsRows.length !== unique.length) {
      throw new BadRequestException(
        'One or more users are not members of this workspace',
      )
    }

    const targetUserIds = Array.from(new Set([...currentIds, ...unique])).sort()
    const mergeIntoId = await this.findConversationIdByExactMemberSet(
      workspaceId,
      targetUserIds,
    )
    if (mergeIntoId && mergeIntoId !== conversationId) {
      const movedIds = await this.db.transaction(async (tx) =>
        this.mergeDmConversationsTx(
          tx,
          workspaceId,
          conversationId,
          mergeIntoId,
        ),
      )
      await this.afterDmMergeBroadcastRealtime(
        workspaceId,
        conversationId,
        mergeIntoId,
        movedIds,
        requesterId,
      )
      return this.getConversationById(mergeIntoId, requesterId, workspaceId)
    }

    const newCount = currentCount + unique.length

    await this.db.transaction(async (tx) => {
      await tx.insert(conversationMembers).values(
        unique.map((userId) => ({
          id: randomUUID(),
          conversationId,
          userId,
        })),
      )
      if (newCount > 2) {
        await tx
          .update(directMessageConversations)
          .set({ isGroup: true })
          .where(eq(directMessageConversations.id, conversationId))
      }
    })

    return this.getConversationById(conversationId, requesterId, workspaceId)
  }

  /**
   * Thêm tối đa (9 − số thành viên hiện tại) người trong workspace chưa có trong conversation.
   */
  async addAllWorkspaceMembersToConversation(
    workspaceId: string,
    conversationId: string,
    requesterId: string,
  ) {
    await this.getConversationById(conversationId, requesterId, workspaceId)

    const currentRows = await this.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId))

    const existingSet = new Set(currentRows.map((r) => r.userId))
    const currentCount = existingSet.size
    const roomLeft = 9 - currentCount

    if (roomLeft <= 0) {
      return this.getConversationById(conversationId, requesterId, workspaceId)
    }

    const wsRows = await this.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.membershipStatus, 'active'),
        ),
      )

    const toAdd = wsRows
      .map((r) => r.userId)
      .filter((uid) => !existingSet.has(uid))
      .slice(0, roomLeft)

    if (toAdd.length === 0) {
      return this.getConversationById(conversationId, requesterId, workspaceId)
    }

    const targetUserIds = Array.from(new Set([...existingSet, ...toAdd])).sort()
    const mergeIntoId = await this.findConversationIdByExactMemberSet(
      workspaceId,
      targetUserIds,
    )
    if (mergeIntoId && mergeIntoId !== conversationId) {
      const movedIds = await this.db.transaction(async (tx) =>
        this.mergeDmConversationsTx(
          tx,
          workspaceId,
          conversationId,
          mergeIntoId,
        ),
      )
      await this.afterDmMergeBroadcastRealtime(
        workspaceId,
        conversationId,
        mergeIntoId,
        movedIds,
        requesterId,
      )
      return this.getConversationById(mergeIntoId, requesterId, workspaceId)
    }

    const newCount = currentCount + toAdd.length

    await this.db.transaction(async (tx) => {
      await tx.insert(conversationMembers).values(
        toAdd.map((userId) => ({
          id: randomUUID(),
          conversationId,
          userId,
        })),
      )
      if (newCount > 2) {
        await tx
          .update(directMessageConversations)
          .set({ isGroup: true })
          .where(eq(directMessageConversations.id, conversationId))
      }
    })

    return this.getConversationById(conversationId, requesterId, workspaceId)
  }

  private toStarredAtIso(v: Date | string | null | undefined): string | null {
    if (v == null) return null
    if (v instanceof Date) return v.toISOString()
    if (typeof v === 'string') return v
    return null
  }

  private broadcastSidebarStarDm(
    userId: string,
    workspaceId: string,
    conversationId: string,
    starredAt: Date | string | null | undefined,
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcastService.broadcastToUser(
      userId,
      workspaceId,
      'sidebar:star',
      {
        kind: 'dm' as const,
        id: conversationId,
        starredAt: this.toStarredAtIso(starredAt),
      },
      excludeSocketId,
    )
  }

  async starConversation(
    workspaceId: string,
    conversationId: string,
    userId: string,
    excludeSocketId?: string,
  ) {
    await this.getConversationById(conversationId, userId, workspaceId)

    const [mem] = await this.db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .limit(1)

    if (!mem) {
      throw new BadRequestException('You are not a member of this conversation')
    }

    await this.db
      .update(conversationMembers)
      .set({ starredAt: new Date() })
      .where(eq(conversationMembers.id, mem.id))

    const updated = await this.getConversationById(
      conversationId,
      userId,
      workspaceId,
    )
    this.broadcastSidebarStarDm(
      userId,
      workspaceId,
      conversationId,
      updated.starredAt,
      excludeSocketId,
    )
    return updated
  }

  async unstarConversation(
    workspaceId: string,
    conversationId: string,
    userId: string,
    excludeSocketId?: string,
  ) {
    await this.getConversationById(conversationId, userId, workspaceId)

    const [mem] = await this.db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      )
      .limit(1)

    if (mem) {
      await this.db
        .update(conversationMembers)
        .set({ starredAt: null })
        .where(eq(conversationMembers.id, mem.id))
    }

    const updated = await this.getConversationById(
      conversationId,
      userId,
      workspaceId,
    )
    this.broadcastSidebarStarDm(
      userId,
      workspaceId,
      conversationId,
      updated.starredAt,
      excludeSocketId,
    )
    return updated
  }
}
