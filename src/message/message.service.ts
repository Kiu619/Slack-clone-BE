/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  messages,
  reactions,
  users,
  workspaceMembers,
  channels,
  channelMembers,
  attachments,
} from '../database/schema'
import { RedisService } from '../redis/redis.service'
import { AttachmentService } from '../attachment/attachment.service'
import type {
  CreateMessageDto,
  UpdateMessageDto,
  AddReactionDto,
} from './dto/create-message.dto'

const PAGE_SIZE = 50

/**
 * TTL cho Redis message cache (tính bằng giây)
 * 30s — đủ để giảm DB load khi nhiều user cùng mở channel,
 * ngắn đủ để không stale khi có message mới (đã invalidate khi create/delete).
 */
const MESSAGE_CACHE_TTL = 30

@Injectable()
export class MessageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly redis: RedisService,
    private readonly attachmentService: AttachmentService,
  ) {}

  /**
   * messageCacheKey — tạo Redis key cho cache messages
   * Chỉ cache page đầu (không có cursor) vì đây là trang hay được fetch nhất
   * khi user mở channel.
   */
  private messageCacheKey(channelId: string): string {
    return `messages:${channelId}:page1`
  }

  /**
   * assertChannelAccess — kiểm tra user có quyền đọc/ghi channel này không
   *
   * Optimization: dùng 1 JOIN query thay vì 2-3 queries tuần tự.
   *
   * Logic:
   *   - LEFT JOIN workspace_members → nếu null: không phải ws member → 403
   *   - LEFT JOIN channel_members → chỉ cần nếu channel là private
   *
   * SQL tương đương:
   *   SELECT c.id, c.workspace_id, c.is_private,
   *          wm.id AS ws_member_id,
   *          cm.id AS ch_member_id
   *   FROM channels c
   *   LEFT JOIN workspace_members wm
   *     ON wm.workspace_id = c.workspace_id AND wm.user_id = $userId
   *   LEFT JOIN channel_members cm
   *     ON cm.channel_id = c.id AND cm.user_id = $userId
   *   WHERE c.id = $channelId
   *   LIMIT 1
   */
  private async assertChannelAccess(channelId: string, userId: string) {
    const [row] = await this.db
      .select({
        id: channels.id,
        workspaceId: channels.workspaceId,
        isPrivate: channels.isPrivate,
        wsMemberId: workspaceMembers.id,
        chMemberId: channelMembers.id,
      })
      .from(channels)
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, channels.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .leftJoin(
        channelMembers,
        and(
          eq(channelMembers.channelId, channels.id),
          eq(channelMembers.userId, userId),
        ),
      )
      .where(eq(channels.id, channelId))
      .limit(1)

    if (!row) throw new NotFoundException('Channel not found')
    if (!row.wsMemberId) throw new ForbiddenException('Not a workspace member')
    if (row.isPrivate && !row.chMemberId)
      throw new ForbiddenException('Not a channel member')

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      isPrivate: row.isPrivate,
    }
  }

  /**
   * getMessages — cursor-based pagination với Redis cache
   *
   * Cursor là createdAt timestamp của message cũ nhất trong trang hiện tại.
   * Lấy các messages có createdAt < cursor, sort DESC, limit PAGE_SIZE.
   * → Kết quả: PAGE_SIZE messages cũ hơn cursor, từ mới → cũ.
   *
   * Caching strategy:
   *   - Chỉ cache page 1 (cursor = undefined) — trang hay xem nhất
   *   - TTL: 30s — giảm DB load khi nhiều user cùng mở 1 channel
   *   - Invalidate: khi createMessage hoặc deleteMessage
   *   - Pages tiếp theo (có cursor) không cache vì ít được fetch
   *
   * Client reverse lại để hiển thị cũ ở trên, mới ở dưới.
   */
  async getMessages(channelId: string, userId: string, cursor?: string) {
    await this.assertChannelAccess(channelId, userId)

    // Cache hit: chỉ check cache cho page 1 (không có cursor)
    if (!cursor) {
      const cached = await this.redis.get(this.messageCacheKey(channelId))
      if (cached) {
        return JSON.parse(cached) as ReturnType<
          typeof this.buildMessagesResponse
        >
      }
    }

    // Base condition: chỉ lấy messages của channel này
    const whereConditions = cursor
      ? and(
          eq(messages.channelId, channelId),
          lt(messages.createdAt, new Date(cursor)),
        )
      : eq(messages.channelId, channelId)

    const rows = (await this.db
      .select({
        // Message fields
        id: messages.id,
        channelId: messages.channelId,
        content: messages.content,
        type: messages.type,
        parentId: messages.parentId,
        editedAt: messages.editedAt,
        deletedAt: messages.deletedAt,
        createdAt: messages.createdAt,
        updatedAt: messages.updatedAt,
        // User fields (join)
        userId: users.id,
        userName: users.name,
        userAvatar: users.avatar,
        userEmail: users.email,
      })
      .from(messages)
      .innerJoin(users, eq(messages.userId, users.id))
      .where(whereConditions)
      .orderBy(desc(messages.createdAt))
      .limit(PAGE_SIZE + 1)) as Array<{
      id: string
      channelId: string
      content: string
      type: string
      parentId: string | null
      editedAt: Date | null
      deletedAt: Date | null
      createdAt: Date
      updatedAt: Date
      userId: string
      userName: string | null
      userAvatar: string | null
      userEmail: string
    }>

    const hasMore = rows.length > PAGE_SIZE
    const messageRows = rows.slice(0, PAGE_SIZE)

    // Lấy reactions và attachments cho các messages này
    const messageIds = messageRows.map((r) => r.id)

    // Parallel fetch reactions + attachments
    const [reactionRows, attachmentsMap] = await Promise.all([
      messageIds.length > 0
        ? (this.db
            .select({
              messageId: reactions.messageId,
              emoji: reactions.emoji,
              userId: reactions.userId,
            })
            .from(reactions)
            /**
             * inArray() từ drizzle-orm → sinh SQL: WHERE message_id IN ($1, $2, $3)
             * Tương đương ANY nhưng đúng cú pháp — không bị lỗi "requires array on right side"
             * Không dùng sql`= ANY(${messageIds})` vì postgres.js truyền JS array
             * dưới dạng tuple thay vì PostgreSQL array type.
             */
            .where(inArray(reactions.messageId, messageIds)) as Promise<
            Array<{
              messageId: string
              emoji: string
              userId: string
            }>
          >)
        : Promise.resolve([]),
      this.attachmentService.getAttachmentsByMessageIds(messageIds),
    ])

    // Group reactions theo messageId
    const reactionsByMessage = reactionRows.reduce<
      Record<string, { emoji: string; count: number; userIds: string[] }[]>
    >((acc, r) => {
      if (!acc[r.messageId]) acc[r.messageId] = []
      const existing = acc[r.messageId].find((x) => x.emoji === r.emoji)
      if (existing) {
        existing.count++
        existing.userIds.push(r.userId)
      } else {
        acc[r.messageId].push({ emoji: r.emoji, count: 1, userIds: [r.userId] })
      }
      return acc
    }, {})

    // Format response
    const formattedMessages = messageRows.map((row) => ({
      id: row.id,
      channelId: row.channelId,
      content: row.deletedAt ? '' : row.content,
      type: row.type,
      parentId: row.parentId,
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      user: {
        id: row.userId,
        name: row.userName,
        avatar: row.userAvatar,
        email: row.userEmail,
      },
      reactions: reactionsByMessage[row.id] ?? [],
      attachments: attachmentsMap.get(row.id) ?? [],
    }))

    const result = this.buildMessagesResponse(
      formattedMessages,
      messageRows,
      hasMore,
    )

    // Lưu cache chỉ cho page 1 (không cursor)
    if (!cursor) {
      await this.redis.set(
        this.messageCacheKey(channelId),
        JSON.stringify(result),
        MESSAGE_CACHE_TTL,
      )
    }

    return result
  }

  /**
   * buildMessagesResponse — helper tạo response object
   * Tách ra để type inference của cache hoạt động đúng
   */
  private buildMessagesResponse(
    formattedMessages: {
      id: string
      channelId: string
      content: string
      type: string
      parentId: string | null
      editedAt: string | null
      deletedAt: string | null
      createdAt: string
      updatedAt: string
      user: {
        id: string
        name: string | null
        avatar: string | null
        email: string
      }
      reactions: { emoji: string; count: number; userIds: string[] }[]
      attachments: Array<typeof attachments.$inferSelect>
    }[],
    messageRows: { createdAt: Date }[],
    hasMore: boolean,
  ) {
    return {
      messages: formattedMessages,
      nextCursor: hasMore
        ? messageRows[messageRows.length - 1].createdAt.toISOString()
        : null,
      hasMore,
    }
  }

  /**
   * createMessage — lưu message vào DB
   *
   * Approach 1 (Normalized): luôn lấy user info từ DB qua JOIN/users table.
   * Khi user đổi avatar/name → tất cả messages hiển thị fresh data (Slack behavior).
   *
   * Performance: dùng Redis cache user profile (TTL 5 phút).
   * Invalidate cache khi user update profile (nếu có endpoint đó).
   */
  async createMessage(
    channelId: string,
    userId: string,
    dto: CreateMessageDto,
  ) {
    await this.assertChannelAccess(channelId, userId)

    const [message] = (await this.db
      .insert(messages)
      .values({
        id: randomUUID(),
        channelId,
        userId,
        content: dto.content,
        type: 'text',
        parentId: dto.parentId ?? null,
      })
      .returning()) as Array<{
      id: string
      channelId: string
      userId: string
      content: string
      type: string
      parentId: string | null
      editedAt: Date | null
      deletedAt: Date | null
      createdAt: Date
      updatedAt: Date
    }>

    // Invalidate page 1 cache vì có message mới → cache cũ sẽ thiếu message này
    await this.redis.del(this.messageCacheKey(channelId))

    // Lấy user info từ DB (với Redis cache) → avatar/name luôn fresh
    const user = await this.getUserProfile(userId)

    return {
      ...message,
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
      user,
      reactions: [],
      attachments: [],
    }
  }

  /**
   * getMessageById — lấy một message cụ thể với full data (user, reactions, attachments)
   * Dùng sau khi client upload attachments xong để fetch lại message đầy đủ.
   */
  async getMessageById(messageId: string, userId: string) {
    // Lấy message + user info
    const [row] = (await this.db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        content: messages.content,
        type: messages.type,
        parentId: messages.parentId,
        editedAt: messages.editedAt,
        deletedAt: messages.deletedAt,
        createdAt: messages.createdAt,
        updatedAt: messages.updatedAt,
        userId: users.id,
        userName: users.name,
        userAvatar: users.avatar,
        userEmail: users.email,
      })
      .from(messages)
      .innerJoin(users, eq(messages.userId, users.id))
      .where(eq(messages.id, messageId))
      .limit(1)) as Array<{
      id: string
      channelId: string
      content: string
      type: string
      parentId: string | null
      editedAt: Date | null
      deletedAt: Date | null
      createdAt: Date
      updatedAt: Date
      userId: string
      userName: string | null
      userAvatar: string | null
      userEmail: string
    }>

    if (!row) {
      throw new NotFoundException('Message not found')
    }

    // Check access
    await this.assertChannelAccess(row.channelId, userId)

    // Parallel fetch reactions + attachments
    const [reactionRows, attachmentsList] = await Promise.all([
      this.db
        .select({
          emoji: reactions.emoji,
          userId: reactions.userId,
        })
        .from(reactions)
        .where(eq(reactions.messageId, messageId)) as Promise<
        Array<{ emoji: string; userId: string }>
      >,
      this.attachmentService.getAttachmentsByMessageId(messageId),
    ])

    // Group reactions
    const groupedReactions = reactionRows.reduce<
      { emoji: string; count: number; userIds: string[] }[]
    >((acc, r) => {
      const existing = acc.find((x) => x.emoji === r.emoji)
      if (existing) {
        existing.count++
        existing.userIds.push(r.userId)
      } else {
        acc.push({ emoji: r.emoji, count: 1, userIds: [r.userId] })
      }
      return acc
    }, [])

    return {
      id: row.id,
      channelId: row.channelId,
      content: row.deletedAt ? '' : row.content,
      type: row.type,
      parentId: row.parentId,
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      user: {
        id: row.userId,
        name: row.userName,
        avatar: row.userAvatar,
        email: row.userEmail,
      },
      reactions: groupedReactions,
      attachments: attachmentsList,
    }
  }

  /**
   * getUserProfile — lấy user id, name, avatar, email
   * Cache trong Redis 5 phút để giảm DB load khi nhiều messages liên tiếp.
   * Khi có endpoint update profile → gọi redis.del(`user:${userId}:profile`) để invalidate.
   */
  private async getUserProfile(userId: string) {
    const cacheKey = `user:${userId}:profile`
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as {
        id: string
        name: string | null
        avatar: string | null
        email: string
      }
    }

    const [user] = (await this.db
      .select({
        id: users.id,
        name: users.name,
        avatar: users.avatar,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)) as Array<{
      id: string
      name: string | null
      avatar: string | null
      email: string
    }>

    if (!user) throw new NotFoundException('User not found')

    const profile = {
      id: user.id,
      name: user.name ?? null,
      avatar: user.avatar ?? null,
      email: user.email,
    }
    await this.redis.set(cacheKey, JSON.stringify(profile), 300) // TTL 5 phút
    return profile
  }

  /** updateMessage — chỉnh sửa nội dung, set editedAt */
  async updateMessage(
    messageId: string,
    userId: string,
    dto: UpdateMessageDto,
  ) {
    const [message] = (await this.db
      .select({
        id: messages.id,
        userId: messages.userId,
        deletedAt: messages.deletedAt,
        channelId: messages.channelId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)) as Array<{
      id: string
      userId: string
      deletedAt: Date | null
      channelId: string
    }>

    if (!message) throw new NotFoundException('Message not found')
    if (message.userId !== userId)
      throw new ForbiddenException('Not your message')
    if (message.deletedAt)
      throw new ForbiddenException('Cannot edit deleted message')

    const [updated] = (await this.db
      .update(messages)
      .set({ content: dto.content, editedAt: new Date() })
      .where(eq(messages.id, messageId))
      .returning()) as Array<{
      id: string
      channelId: string
      userId: string
      content: string
      type: string
      parentId: string | null
      editedAt: Date | null
      deletedAt: Date | null
      createdAt: Date
      updatedAt: Date
    }>

    return {
      ...updated,
      editedAt: updated.editedAt?.toISOString() ?? null,
      deletedAt: updated.deletedAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    }
  }

  /** deleteMessage — soft delete, không xóa khỏi DB */
  async deleteMessage(messageId: string, userId: string) {
    const [message] = (await this.db
      .select({
        id: messages.id,
        userId: messages.userId,
        channelId: messages.channelId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)) as Array<{
      id: string
      userId: string
      channelId: string
    }>

    if (!message) throw new NotFoundException('Message not found')
    if (message.userId !== userId)
      throw new ForbiddenException('Not your message')

    await this.db
      .update(messages)
      .set({ deletedAt: new Date(), content: '' })
      .where(eq(messages.id, messageId))

    // Invalidate cache vì message đã bị xóa (soft delete)
    await this.redis.del(this.messageCacheKey(message.channelId))

    return { messageId, channelId: message.channelId, deleted: true }
  }

  /**
   * toggleReaction — thêm hoặc bỏ reaction
   * Nếu đã react với emoji này → bỏ (toggle)
   * Nếu chưa → thêm
   */
  async toggleReaction(messageId: string, userId: string, dto: AddReactionDto) {
    // Lấy channelId từ message để broadcast đúng room
    const [messageRow] = (await this.db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)) as Array<{ channelId: string }>

    if (!messageRow) throw new NotFoundException('Message not found')

    const [existing] = (await this.db
      .select({ id: reactions.id })
      .from(reactions)
      .where(
        and(
          eq(reactions.messageId, messageId),
          eq(reactions.userId, userId),
          eq(reactions.emoji, dto.emoji),
        ),
      )
      .limit(1)) as Array<{ id: string }>

    if (existing) {
      await this.db.delete(reactions).where(eq(reactions.id, existing.id))
      return {
        action: 'removed',
        emoji: dto.emoji,
        channelId: messageRow.channelId,
      }
    } else {
      await this.db.insert(reactions).values({
        id: randomUUID(),
        messageId,
        userId,
        emoji: dto.emoji,
      })
      return {
        action: 'added',
        emoji: dto.emoji,
        channelId: messageRow.channelId,
      }
    }
  }
}
