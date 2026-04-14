import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm'
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
import { S3Service } from '../upload/s3.service'
import type {
  CreateMessageDto,
  UpdateMessageDto,
  AddReactionDto,
} from './dto/create-message.dto'

const PAGE_SIZE = 20

/** Phân trang tab Files — theo `attachments.createdAt` + `attachments.id` */
const CHANNEL_FILES_PAGE_SIZE = 30

/**
 * TTL cho Redis message cache (tính bằng giây)
 * 30s — đủ để giảm DB load khi nhiều user cùng mở channel,
 * ngắn đủ để không stale khi có message mới (đã invalidate khi create/delete).
 */
const MESSAGE_CACHE_TTL = 30

type ChannelFileJoinRow = {
  attId: string
  attMessageId: string
  attUrl: string
  attType: string
  attName: string
  attSize: number
  attMimeType: string | null
  attWidth: number | null
  attHeight: number | null
  attDuration: number | null
  attCreatedAt: Date
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
  userEmail: string
  userName: string | null
  userAvatar: string | null
  userDisplayName: string | null
  userIsAway: boolean | null
  userNamePronunciation: string | null
  userPhone: string | null
  userDescription: string | null
  userTimeZone: string | null
}

@Injectable()
export class MessageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly redis: RedisService,
    private readonly attachmentService: AttachmentService,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * Chuyển S3 URL thành presigned GET URL (bucket private → cần signed URL để truy cập).
   * Truyền att.name để Content-Disposition đúng tên tiếng Việt khi download.
   */
  private async enrichAttachmentWithSignedUrl<
    T extends { url: string; name?: string },
  >(att: T): Promise<T> {
    const key = this.s3Service.parseS3KeyFromUrl(att.url)
    if (!key) return att
    try {
      const signedUrl = await this.s3Service.getPresignedGetUrl(
        key,
        86400,
        att.name,
      )
      return { ...att, url: signedUrl }
    } catch {
      return att
    }
  }

  /**
   * messageCacheKey — tạo Redis key cho cache messages
   * Chỉ cache page đầu (không có cursor) vì đây là trang hay được fetch nhất
   * khi user mở channel.
   */
  private messageCacheKey(channelId: string): string {
    return `messages:v2:${channelId}:page1`
  }

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
    if (!row.chMemberId) throw new ForbiddenException('Not a channel member')

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      isPrivate: row.isPrivate,
    }
  }

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
        userId: users.id,
        userEmail: users.email,
        userName: sql<
          string | null
        >`COALESCE(${workspaceMembers.name}, ${users.name})`,
        userAvatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        userDisplayName: sql<
          string | null
        >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userPhone: workspaceMembers.phone,
        userDescription: workspaceMembers.description,
        userTimeZone: workspaceMembers.timeZone,
      })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, channels.workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
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
      userEmail: string
      userName: string | null
      userDisplayName: string | null
      userAvatar: string | null
      userIsAway: boolean | null
      userStatus: string | null
      userNamePronunciation: string | null
      userPhone: string | null
      userDescription: string | null
      userTimeZone: string | null
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

    // Format response — enrich S3 URLs với presigned URL (bucket private)
    const formattedMessages = await Promise.all(
      messageRows.map(async (row) => {
        const atts = attachmentsMap.get(row.id) ?? []
        const enrichedAtts = await Promise.all(
          atts.map((a) => this.enrichAttachmentWithSignedUrl(a)),
        )
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
            displayName: row.userDisplayName,
            isAway: row.userIsAway,
            status: row.userStatus,
            namePronunciation: row.userNamePronunciation,
            phone: row.userPhone,
            description: row.userDescription,
            timeZone: row.userTimeZone,
          },
          reactions: reactionsByMessage[row.id] ?? [],
          attachments: enrichedAtts,
        }
      }),
    )

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
        displayName: string | null
        isAway: boolean | null
        status: string | null
        namePronunciation: string | null
        phone: string | null
        description: string | null
        timeZone: string | null
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

  async createMessage(
    channelId: string,
    userId: string,
    dto: CreateMessageDto,
  ) {
    const { workspaceId } = await this.assertChannelAccess(channelId, userId)

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

    const user = await this.getAuthorProfileForWorkspace(userId, workspaceId)

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
        userEmail: users.email,
        userName: sql<
          string | null
        >`COALESCE(${workspaceMembers.name}, ${users.name})`,
        userAvatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        userDisplayName: sql<
          string | null
        >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userPhone: workspaceMembers.phone,
        userDescription: workspaceMembers.description,
        userTimeZone: workspaceMembers.timeZone,
      })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, channels.workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
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
      userDisplayName: string | null
      userIsAway: boolean | null
      userStatus: string | null
      userNamePronunciation: string | null
      userPhone: string | null
      userDescription: string | null
      userTimeZone: string | null
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

    // Enrich S3 URLs với presigned URL
    const enrichedAttachments = await Promise.all(
      attachmentsList.map((a) => this.enrichAttachmentWithSignedUrl(a)),
    )

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
        displayName: row.userDisplayName,
        isAway: row.userIsAway,
        status: row.userStatus,
        namePronunciation: row.userNamePronunciation,
        phone: row.userPhone,
        description: row.userDescription,
        timeZone: row.userTimeZone,
      },
      reactions: groupedReactions,
      attachments: enrichedAttachments,
    }
  }

  /**
   * Profile tác giả message theo workspace (Slack-style).
   * Invalidate: redis.del(`ws:${workspaceId}:user:${userId}:profile`) khi sửa workspace profile.
   */
  private async getAuthorProfileForWorkspace(
    userId: string,
    workspaceId: string,
  ) {
    const cacheKey = `ws:${workspaceId}:user:${userId}:profile`
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as {
        id: string
        name: string | null
        avatar: string | null
        email: string
        displayName: string | null
        isAway: boolean
        status: string | null
        namePronunciation: string | null
        phone: string | null
        description: string | null
        timeZone: string | null
      }
    }

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        accountName: users.name,
        accountAvatar: users.avatar,
        wmName: workspaceMembers.name,
        wmAvatar: workspaceMembers.avatar,
        displayName: workspaceMembers.displayName,
        isAway: workspaceMembers.isAway,
        namePronunciation: workspaceMembers.namePronunciation,
        phone: workspaceMembers.phone,
        description: workspaceMembers.description,
        timeZone: workspaceMembers.timeZone,
      })
      .from(users)
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .where(eq(users.id, userId))
      .limit(1)

    if (!row) throw new NotFoundException('User not found')

    const name = row.wmName ?? row.accountName ?? null
    const avatar = row.wmAvatar ?? row.accountAvatar ?? null
    const profile = {
      id: row.id,
      name,
      avatar,
      email: row.email,
      displayName: row.displayName ?? name,
      isAway: row.isAway ?? false,
      namePronunciation: row.namePronunciation ?? null,
      phone: row.phone ?? null,
      description: row.description ?? null,
      timeZone: row.timeZone ?? null,
    }
    await this.redis.set(cacheKey, JSON.stringify(profile), 300)
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

  private parseAttachmentCursor(
    cursor?: string,
  ): { at: Date; id: string } | null {
    if (!cursor?.trim()) return null
    const sep = cursor.lastIndexOf('__')
    if (sep <= 0) return null
    const t = cursor.slice(0, sep)
    const id = cursor.slice(sep + 2)
    if (!id) return null
    const at = new Date(t)
    if (Number.isNaN(at.getTime())) return null
    return { at, id }
  }

  private async mapChannelFileJoinRowsToHits(rows: ChannelFileJoinRow[]) {
    return Promise.all(
      rows.map(async (row) => {
        const rawAtt = {
          id: row.attId,
          messageId: row.attMessageId,
          url: row.attUrl,
          type: row.attType,
          name: row.attName,
          size: row.attSize,
          mimeType: row.attMimeType,
          width: row.attWidth,
          height: row.attHeight,
          duration: row.attDuration,
          createdAt: row.attCreatedAt,
        }
        const enrichedAtt = await this.enrichAttachmentWithSignedUrl(rawAtt)
        const attCreated =
          enrichedAtt.createdAt instanceof Date
            ? enrichedAtt.createdAt.toISOString()
            : String(enrichedAtt.createdAt)
        const attachment = {
          ...enrichedAtt,
          createdAt: attCreated,
        }
        const message = {
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
            displayName: row.userDisplayName,
            isAway: row.userIsAway,
            status: null as string | null,
            namePronunciation: row.userNamePronunciation,
            phone: row.userPhone,
            description: row.userDescription,
            timeZone: row.userTimeZone,
          },
          reactions: [] as {
            emoji: string
            count: number
            userIds: string[]
          }[],
          attachments: [attachment],
        }
        return { attachment, message }
      }),
    )
  }

  /**
   * Danh sách attachment trong channel (tab Files), cursor ổn định theo thời gian + id.
   */
  async listChannelAttachments(
    channelId: string,
    userId: string,
    cursor?: string,
    limit = CHANNEL_FILES_PAGE_SIZE,
  ) {
    await this.assertChannelAccess(channelId, userId)

    const parsed = this.parseAttachmentCursor(cursor)
    const cursorCond = parsed
      ? or(
          lt(attachments.createdAt, parsed.at),
          and(
            eq(attachments.createdAt, parsed.at),
            lt(attachments.id, parsed.id),
          ),
        )
      : undefined

    const whereExpr = cursorCond
      ? and(
          eq(messages.channelId, channelId),
          isNull(messages.deletedAt),
          cursorCond,
        )
      : and(eq(messages.channelId, channelId), isNull(messages.deletedAt))

    const rows = (await this.db
      .select({
        attId: attachments.id,
        attMessageId: attachments.messageId,
        attUrl: attachments.url,
        attType: attachments.type,
        attName: attachments.name,
        attSize: attachments.size,
        attMimeType: attachments.mimeType,
        attWidth: attachments.width,
        attHeight: attachments.height,
        attDuration: attachments.duration,
        attCreatedAt: attachments.createdAt,
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
        userEmail: users.email,
        userName: sql<
          string | null
        >`COALESCE(${workspaceMembers.name}, ${users.name})`,
        userAvatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        userDisplayName: sql<
          string | null
        >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userPhone: workspaceMembers.phone,
        userDescription: workspaceMembers.description,
        userTimeZone: workspaceMembers.timeZone,
      })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, channels.workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .where(whereExpr)
      .orderBy(desc(attachments.createdAt), desc(attachments.id))
      .limit(limit + 1)) as ChannelFileJoinRow[]

    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const results = await this.mapChannelFileJoinRowsToHits(pageRows)

    const last = pageRows[pageRows.length - 1]
    const nextCursor =
      hasMore && last
        ? `${last.attCreatedAt.toISOString()}__${last.attId}`
        : null

    return { results, nextCursor, hasMore }
  }

  /**
   * Tìm file đính kèm trong channel theo tên (ILIKE, không phân biệt hoa thường).
   * Dùng cho tab Files: gợi ý search + lọc sau khi Enter.
   */
  async searchChannelFiles(
    channelId: string,
    userId: string,
    q: string,
    limit = 30,
  ) {
    await this.assertChannelAccess(channelId, userId)
    const term = q.trim()
    if (!term) {
      return { results: [] }
    }

    const escaped = term
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
    const pattern = `%${escaped}%`

    const rows = (await this.db
      .select({
        attId: attachments.id,
        attMessageId: attachments.messageId,
        attUrl: attachments.url,
        attType: attachments.type,
        attName: attachments.name,
        attSize: attachments.size,
        attMimeType: attachments.mimeType,
        attWidth: attachments.width,
        attHeight: attachments.height,
        attDuration: attachments.duration,
        attCreatedAt: attachments.createdAt,
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
        userEmail: users.email,
        userName: sql<
          string | null
        >`COALESCE(${workspaceMembers.name}, ${users.name})`,
        userAvatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        userDisplayName: sql<
          string | null
        >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userPhone: workspaceMembers.phone,
        userDescription: workspaceMembers.description,
        userTimeZone: workspaceMembers.timeZone,
      })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, channels.workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .where(
        and(
          eq(messages.channelId, channelId),
          isNull(messages.deletedAt),
          ilike(attachments.name, pattern),
        ),
      )
      .orderBy(desc(attachments.createdAt), desc(attachments.id))
      .limit(limit)) as ChannelFileJoinRow[]

    const results = await this.mapChannelFileJoinRowsToHits(rows)

    return { results }
  }
}
