/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common'
import { randomUUID } from 'crypto'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { supportsOfficeThumbnail } from '../attachment-preview/office-preview.utils'
import {
  OfficeThumbnailError,
  OfficeThumbnailGeneratorService,
} from '../attachment-preview/office-thumbnail-generator.service'
import { AttachmentService } from '../attachment/attachment.service'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  attachments,
  channelMembers,
  channels,
  conversationMembers,
  directMessageConversations,
  messages,
  reactions,
  threadSubscriptions,
  users,
  workspaceMembers,
} from '../database/schema'
import { LaterService } from '../later/later.service'
import { NotificationService } from '../notification/notification.service'
import { RedisService } from '../redis/redis.service'
import { S3Service } from '../upload/s3.service'
import { WorkspacePermissionsService } from '../workspace/workspace-permissions.service'
import type {
  AddReactionDto,
  CreateMessageDto,
  UpdateMessageDto,
} from './dto/create-message.dto'
import type { ForwardMessageDto } from './dto/forward-message.dto'
import type { SearchWorkspaceMessagesDto } from './dto/search-workspace-messages.dto'

const PAGE_SIZE = 20

/** Phân trang tab Files — theo `attachments.createdAt` + `attachments.id` */
const CHANNEL_FILES_PAGE_SIZE = 30

/**
 * TTL cho Redis message cache (tính bằng giây)
 * 30s — đủ để giảm DB load khi nhiều user cùng mở channel,
 * ngắn đủ để không stale khi có message mới (đã invalidate khi create/delete).
 */
const MESSAGE_CACHE_TTL = 30

const removedAuthorNameExpr = sql<
  string | null
>`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated user' ELSE COALESCE(${workspaceMembers.name}, ${users.name}) END`
const removedAuthorDisplayNameExpr = sql<
  string | null
>`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated user' ELSE COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name}) END`
const removedAuthorAvatarExpr = sql<
  string | null
>`CASE WHEN ${workspaceMembers.id} IS NULL THEN NULL ELSE COALESCE(${workspaceMembers.avatar}, ${users.avatar}) END`

type MessageJoinRow = {
  id: string
  workspaceId: string
  channelId: string | null
  conversationId: string | null
  content: string
  type: 'text' | 'system' | 'timeline' | 'huddle'
  parentId: string | null
  huddleSessionId?: string | null
  huddleSnapshot?: unknown | null
  alsoSendToChannel: boolean
  replyCount: number
  replyParticipantIds: string[]
  lastReplyAt: Date | null
  editedAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
  isPinned: boolean
  allowEdit: boolean
  userId: string
  userEmail: string
  userName: string | null
  userAvatar: string | null
  userDisplayName: string | null
  userIsAway: boolean | null
  userStatus: string | null
  userStatusEmoji: string | null
  userNamePronunciation: string | null
  userPhone: string | null
  userDescription: string | null
  userTimeZone: string | null
  parentContent?: string | null
  parentDeletedAt?: Date | null
  forwardSnapshot?: unknown | null
  /** Có khi query join bảng `channels` (vd. getMessageById, getMessagesByIds, getThreads) */
  channelName?: string | null
}

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
  channelId: string | null
  conversationId: string | null
  content: string
  type: 'text' | 'system' | 'timeline' | 'huddle'
  parentId: string | null
  huddleSessionId?: string | null
  huddleSnapshot?: unknown | null
  alsoSendToChannel: boolean
  replyCount: number
  replyParticipantIds: string[]
  lastReplyAt: Date | null
  editedAt: Date | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
  isPinned: boolean
  allowEdit: boolean
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
  userStatus: string | null
  userStatusEmoji: string | null
}

type ReactionUserSnapshot = {
  id: string
  name: string | null
  displayName: string | null
  avatar: string | null
}

type ReactionSnapshotRow = {
  messageId: string
  emoji: string
  userId: string
  userName: string | null
  userDisplayName: string | null
  userAvatar: string | null
}

type ReactionSnapshot = {
  emoji: string
  count: number
  userIds: string[]
  users: ReactionUserSnapshot[]
}

type WorkspaceMessageSearchRow = MessageJoinRow & {
  rank: number | null
  excerpt: string
  channelName: string | null
  channelIsPrivate: boolean | null
  conversationIsGroup: boolean | null
  conversationLabel: string | null
}

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly redis: RedisService,
    private readonly attachmentService: AttachmentService,
    private readonly officeThumbnailGenerator: OfficeThumbnailGeneratorService,
    private readonly s3Service: S3Service,
    private readonly notificationService: NotificationService,
    private readonly permissionsService: WorkspacePermissionsService,
    @Inject(forwardRef(() => LaterService))
    private readonly laterService: LaterService,
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

  /** Snapshot lồng trên message (đủ field để unwrap / phân mixed forward). */
  private parseNestedForwardSnapshot(raw: unknown): {
    sourceMessageId: string
    sourceUser: unknown
    sourceContent: string
    sourceEditedAt: string | null
  } | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (
      typeof o.sourceMessageId !== 'string' ||
      !o.sourceUser ||
      typeof o.sourceContent !== 'string'
    ) {
      return null
    }
    const edited = o.sourceEditedAt
    let sourceEditedAt: string | null = null
    if (edited instanceof Date) sourceEditedAt = edited.toISOString()
    else if (typeof edited === 'string') sourceEditedAt = edited
    else if (edited === null || edited === undefined) sourceEditedAt = null

    return {
      sourceMessageId: o.sourceMessageId,
      sourceUser: o.sourceUser,
      sourceContent: o.sourceContent,
      sourceEditedAt,
    }
  }

  /** Có file đính kèm thuộc phần body (không phải chỉ quote forward). */
  private hasBodyOwnedAttachments(src: Record<string, any>): boolean {
    const list = (src.attachments ?? []) as Array<{ originScope?: string }>
    return list.some((a) => a.originScope !== 'forward_quote')
  }

  /** Có text commentary thật phía trên block forward (phân nhánh mixed). */
  private hasMeaningfulForwarderText(html: string | null | undefined): boolean {
    if (html == null) return false
    const t = html.trim()
    if (
      t === '' ||
      t === '<p></p>' ||
      t === '<p><br></p>' ||
      /^<p>\s*<\/p>$/i.test(t)
    ) {
      return false
    }
    if (t.includes('Đang tải file') || t.includes('Tải file thất bại')) {
      return false
    }
    const plain = t
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim()
    return plain.length > 0
  }

  /**
   * Đi theo chuỗi forward_snapshot tới message gốc (tối đa 10 bước) để snapshot tin forward mới trỏ đúng tác giả/nội dung.
   */
  private async resolveForwardSnapshotForOutgoingForward(
    src: Record<string, any>,
    userId: string,
  ): Promise<Record<string, unknown>> {
    let current: Record<string, any> = src
    for (let i = 0; i < 10; i++) {
      const snap = this.parseNestedForwardSnapshot(current.forwardSnapshot)
      if (!snap) {
        return {
          sourceMessageId: current.id,
          sourceUser: current.user,
          sourceContent: current.content,
          sourceEditedAt: current.editedAt ?? null,
        }
      }
      current = (await this.getMessageById(
        snap.sourceMessageId,
        userId,
      )) as Record<string, any>
    }
    return {
      sourceMessageId: current.id,
      sourceUser: current.user,
      sourceContent: current.content,
      sourceEditedAt: current.editedAt ?? null,
    }
  }

  /**
   * messageCacheKey — tạo Redis key cho cache messages
   * Chỉ cache page đầu (không có cursor) vì đây là trang hay được fetch nhất
   * khi user mở channel.
   */
  private messageCacheKey(targetId: string): string {
    return `messages:v2:${targetId}:page1`
  }

  private resolveAttachmentFileCategory(
    name: string,
    mimeType?: string | null,
    fileCategory?: string | null,
  ) {
    if (fileCategory) return fileCategory

    const ext = name.split('.').pop()?.toLowerCase()
    if (ext) {
      if (['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return 'spreadsheet'
      if (['pptx', 'ppt', 'odp'].includes(ext)) return 'presentation'
      if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext)) return 'document'
    }

    if (!mimeType) return 'other'
    if (
      mimeType.includes('spreadsheet') ||
      mimeType.includes('excel') ||
      mimeType.includes('sheet') ||
      mimeType.includes('csv')
    ) {
      return 'spreadsheet'
    }
    if (
      mimeType.includes('presentation') ||
      mimeType.includes('powerpoint') ||
      mimeType.includes('officedocument.presentationml')
    ) {
      return 'presentation'
    }
    if (
      mimeType.includes('word') ||
      mimeType.includes('officedocument.wordprocessingml') ||
      mimeType === 'application/msword' ||
      mimeType.includes('document') ||
      mimeType.includes('wordprocessingml')
    ) {
      return 'document'
    }

    return 'other'
  }

  /** Xóa cache Redis trang 1 tin (channel hoặc DM) — dùng sau merge / bulk update. */
  private async buildAttachmentInsertValue(
    attachment: {
      url: string
      type: string
      name: string
      size: number
      mimeType?: string | null
      width?: number | null
      height?: number | null
      duration?: number | null
      fileCategory?: string | null
    },
    context: {
      messageId: string
      workspaceId: string
      userId: string
      channelId: string | null
      conversationId: string | null
      originScope: string
    },
  ) {
    const fileCategory = this.resolveAttachmentFileCategory(
      attachment.name,
      attachment.mimeType,
      attachment.fileCategory,
    )
    const attachmentId = randomUUID()
    let previewImageUrl: string | null = null
    let previewStatus: 'ready' | 'failed' | null = null
    let previewUpdatedAt: Date | null = null
    let previewErrorCode: string | null = null

    if (supportsOfficeThumbnail(fileCategory)) {
      try {
        const preview = await this.officeThumbnailGenerator.generateThumbnail({
          id: attachmentId,
          workspaceId: context.workspaceId,
          name: attachment.name,
          url: attachment.url,
        })
        previewImageUrl = preview.previewImageUrl
        previewStatus = 'ready'
        previewUpdatedAt = new Date()
      } catch (error) {
        const previewError =
          error instanceof OfficeThumbnailError
            ? error
            : new OfficeThumbnailError(
                'unknown_preview_error',
                'Unknown Office preview generation error.',
              )
        this.logger.warn(
          `Office preview sync failed for ${attachment.name}: ${previewError.code}`,
        )
        previewStatus = 'failed'
        previewUpdatedAt = new Date()
        previewErrorCode = previewError.code
      }
    }

    return {
      id: attachmentId,
      messageId: context.messageId,
      workspaceId: context.workspaceId,
      userId: context.userId,
      channelId: context.channelId,
      conversationId: context.conversationId,
      ...attachment,
      fileCategory,
      previewImageUrl,
      previewStatus,
      previewUpdatedAt,
      previewErrorCode,
      originScope: context.originScope,
    }
  }

  async invalidateMessagePage1Caches(conversationOrChannelIds: string[]) {
    const ids = [...new Set(conversationOrChannelIds.filter(Boolean))]
    if (ids.length === 0) return
    await Promise.all(ids.map((id) => this.redis.del(this.messageCacheKey(id))))
  }

  private getMessageSelectFields() {
    return {
      id: messages.id,
      channelId: messages.channelId,
      conversationId: messages.conversationId,
      content: messages.content,
      type: messages.type,
      parentId: messages.parentId,
      huddleSessionId: messages.huddleSessionId,
      huddleSnapshot: messages.huddleSnapshot,
      alsoSendToChannel: messages.alsoSendToChannel,
      replyCount: messages.replyCount,
      replyParticipantIds: sql<string[]>`
        COALESCE(
          (
            SELECT array_agg(DISTINCT m2.user_id)
            FROM ${messages} m2
            WHERE m2.parent_id = ${messages.id}
          ),
          '{}'
        )
      `,
      lastReplyAt: messages.lastReplyAt,
      editedAt: messages.editedAt,
      deletedAt: messages.deletedAt,
      createdAt: messages.createdAt,
      updatedAt: messages.updatedAt,
      isPinned: messages.isPinned,
      allowEdit: messages.allowEdit,
      userId: users.id,
      userEmail: users.email,
      userName: removedAuthorNameExpr,
      userAvatar: removedAuthorAvatarExpr,
      userDisplayName: removedAuthorDisplayNameExpr,
      userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
      userStatus: workspaceMembers.statusText,
      userStatusEmoji: workspaceMembers.statusEmoji,
      userNamePronunciation: workspaceMembers.namePronunciation,
      userPhone: workspaceMembers.phone,
      userDescription: workspaceMembers.description,
      userTimeZone: workspaceMembers.timeZone,
      parentContent: sql<string | null>`parents.content`,
      parentDeletedAt: sql<Date | null>`parents.deleted_at`,
      forwardSnapshot: messages.forwardSnapshot,
    }
  }

  private async fetchMetadataForMessages(
    messageIds: string[],
    parentIds: string[] = [],
  ) {
    const allRelevantIds = Array.from(new Set([...messageIds, ...parentIds]))

    const [reactionRows, attachmentsMap] = await Promise.all([
      this.fetchReactionSnapshotRows(messageIds),
      this.attachmentService.getAttachmentsByMessageIds(allRelevantIds),
    ])

    const reactionsByMessage = reactionRows.reduce<
      Record<string, ReactionSnapshot[]>
    >((acc, r) => {
      if (!acc[r.messageId]) acc[r.messageId] = []
      const existing = acc[r.messageId].find((x) => x.emoji === r.emoji)
      if (existing) {
        existing.count++
        existing.userIds.push(r.userId)
        existing.users.push({
          id: r.userId,
          name: r.userName,
          displayName: r.userDisplayName,
          avatar: r.userAvatar,
        })
      } else {
        acc[r.messageId].push({
          emoji: r.emoji,
          count: 1,
          userIds: [r.userId],
          users: [
            {
              id: r.userId,
              name: r.userName,
              displayName: r.userDisplayName,
              avatar: r.userAvatar,
            },
          ],
        })
      }
      return acc
    }, {})

    return { reactionsByMessage, attachmentsMap }
  }

  private async fetchReactionSnapshotRows(
    messageIds: string[],
  ): Promise<ReactionSnapshotRow[]> {
    if (messageIds.length === 0) return []

    return (await this.db
      .select({
        messageId: reactions.messageId,
        emoji: reactions.emoji,
        userId: reactions.userId,
        userName: removedAuthorNameExpr,
        userDisplayName: removedAuthorDisplayNameExpr,
        userAvatar: removedAuthorAvatarExpr,
      })
      .from(reactions)
      .innerJoin(messages, eq(reactions.messageId, messages.id))
      .innerJoin(users, eq(reactions.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, reactions.userId),
          eq(workspaceMembers.workspaceId, messages.workspaceId),
        ),
      )
      .where(inArray(reactions.messageId, messageIds))) as ReactionSnapshotRow[]
  }

  private async formatMessageRow(
    row: MessageJoinRow,
    reactionsByMessage: Record<string, ReactionSnapshot[]>,
    attachmentsMap: Map<string, any[]>,
  ) {
    const atts = attachmentsMap.get(row.id) ?? []
    const enrichedAtts = await Promise.all(
      atts.map((a) => this.enrichAttachmentWithSignedUrl(a)),
    )

    return {
      id: row.id,
      channelId: row.channelId,
      conversationId: row.conversationId,
      content: row.deletedAt ? '' : row.content,
      type: row.type,
      parentId: row.parentId,
      huddleSessionId: row.huddleSessionId ?? null,
      huddleSnapshot:
        row.huddleSnapshot != null
          ? (row.huddleSnapshot as Record<string, unknown>)
          : null,
      alsoSendToChannel: row.alsoSendToChannel,
      replyCount: row.replyCount,
      replyParticipantIds: row.replyParticipantIds,
      lastReplyAt: row.lastReplyAt?.toISOString() ?? null,
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      isPinned: row.isPinned,
      allowEdit: row.allowEdit,
      channelName: row.channelName ?? null,
      user: {
        id: row.userId,
        name: row.userName,
        avatar: row.userAvatar,
        email: row.userEmail,
        displayName: row.userDisplayName,
        isAway: row.userIsAway,
        status: row.userStatus,
        statusText: row.userStatus,
        statusEmoji: row.userStatusEmoji,
        namePronunciation: row.userNamePronunciation,
        phone: row.userPhone,
        description: row.userDescription,
        timeZone: row.userTimeZone,
      },
      reactions: reactionsByMessage[row.id] ?? [],
      attachments: enrichedAtts,
      parent:
        row.parentId && row.alsoSendToChannel
          ? {
              content: row.parentDeletedAt ? '' : (row.parentContent ?? ''),
              deletedAt: row.parentDeletedAt?.toISOString() ?? null,
              attachments: await Promise.all(
                (attachmentsMap.get(row.parentId) ?? []).map((a) =>
                  this.enrichAttachmentWithSignedUrl(a),
                ),
              ),
            }
          : undefined,
      ...(row.forwardSnapshot != null
        ? { forwardSnapshot: row.forwardSnapshot as Record<string, unknown> }
        : {}),
    }
  }

  private async assertConversationAccess(
    conversationId: string,
    userId: string,
  ) {
    const [row] = await this.db
      .select({
        id: directMessageConversations.id,
        workspaceId: directMessageConversations.workspaceId,
        memberId: conversationMembers.id,
        membershipStatus: workspaceMembers.membershipStatus,
      })
      .from(directMessageConversations)
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, directMessageConversations.id),
          eq(conversationMembers.userId, userId),
        ),
      )
      .innerJoin(
        workspaceMembers,
        and(
          eq(
            workspaceMembers.workspaceId,
            directMessageConversations.workspaceId,
          ),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .where(eq(directMessageConversations.id, conversationId))
      .limit(1)

    if (!row)
      throw new NotFoundException('Conversation not found or access denied')
    if (row.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }

    return {
      id: row.id,
      workspaceId: row.workspaceId,
    }
  }

  private async assertWorkspaceAccess(workspaceId: string, userId: string) {
    const [row] = await this.db
      .select({
        id: workspaceMembers.id,
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

    if (!row) {
      throw new ForbiddenException('Not a workspace member')
    }
    if (row.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }
  }

  private async assertChannelAccess(channelId: string, userId: string) {
    const [row] = await this.db
      .select({
        id: channels.id,
        workspaceId: channels.workspaceId,
        isPrivate: channels.isPrivate,
        wsMemberId: workspaceMembers.id,
        wsMembershipStatus: workspaceMembers.membershipStatus,
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
    if (row.wsMembershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }
    if (!row.chMemberId && row.isPrivate)
      throw new ForbiddenException('Not a channel member')

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      isPrivate: row.isPrivate,
    }
  }

  private async getChannelPostingPermission(channelId: string, userId: string) {
    const [row] = await this.db
      .select({
        channelId: channels.id,
        workspaceId: channels.workspaceId,
        postingSettings: channels.postingSettings,
      })
      .from(channels)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, channels.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .where(eq(channels.id, channelId))
      .limit(1)

    if (!row) {
      throw new NotFoundException('Channel not found or access denied')
    }

    const settings = row.postingSettings
    const isAdmin = await this.permissionsService.canUser(
      row.workspaceId,
      userId,
      'manage_user_permissions',
    )
    const canPost =
      !settings ||
      settings.mode === 'everyone' ||
      (settings.mode === 'admin_only'
        ? isAdmin
        : isAdmin || settings.specificUserIds.includes(userId))

    const canReply = !settings || settings.allowThreads ? true : canPost
    const canSendToChannel = canPost
    const canMentionChannelWide = !settings || settings.allowMentions

    return {
      canPost,
      canReply,
      canSendToChannel,
      canMentionChannelWide,
    }
  }

  async getMessages(
    params: { channelId?: string; conversationId?: string },
    userId: string,
    cursor?: string,
    direction: 'forward' | 'backward' = 'backward',
  ) {
    const { channelId, conversationId } = params
    const targetId = (channelId || conversationId) as string

    let workspaceId: string
    if (channelId) {
      const ch = await this.assertChannelAccess(channelId, userId)
      workspaceId = ch.workspaceId
    } else {
      const conv = await this.assertConversationAccess(conversationId!, userId)
      workspaceId = conv.workspaceId
    }

    // Cache hit: chỉ check cache cho page 1 (không có cursor)
    if (!cursor) {
      const cached = await this.redis.get(this.messageCacheKey(targetId))
      if (cached) {
        return JSON.parse(cached) as ReturnType<
          typeof this.buildMessagesResponse
        >
      }
    }

    let cursorDate: Date | undefined
    let cursorId: string | undefined
    if (cursor) {
      const parts = cursor.split('|')
      cursorDate = new Date(parts[0])
      cursorId = parts.length > 1 ? parts[1] : undefined
      if (cursorDate && isNaN(cursorDate.getTime())) cursorDate = undefined
    }

    const whereConditions = cursorDate
      ? and(
          channelId
            ? eq(messages.channelId, channelId)
            : eq(messages.conversationId, conversationId!),
          direction === 'forward'
            ? cursorId
              ? or(
                  gt(messages.createdAt, cursorDate),
                  and(
                    eq(messages.createdAt, cursorDate),
                    gt(messages.id, cursorId),
                  ),
                )
              : gt(messages.createdAt, cursorDate)
            : cursorId
              ? or(
                  lt(messages.createdAt, cursorDate),
                  and(
                    eq(messages.createdAt, cursorDate),
                    lt(messages.id, cursorId),
                  ),
                )
              : lt(messages.createdAt, cursorDate),
          or(isNull(messages.parentId), eq(messages.alsoSendToChannel, true)),
        )
      : and(
          channelId
            ? eq(messages.channelId, channelId)
            : eq(messages.conversationId, conversationId!),
          or(isNull(messages.parentId), eq(messages.alsoSendToChannel, true)),
        )

    const rows = (await this.db
      .select(this.getMessageSelectFields())
      .from(messages)
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .leftJoin(
        sql`${messages} AS parents`,
        eq(messages.parentId, sql`parents.id`),
      )
      .where(whereConditions)
      .orderBy(
        ...(direction === 'forward'
          ? [asc(messages.createdAt), asc(messages.id)]
          : [desc(messages.createdAt), desc(messages.id)]),
      )
      .limit(PAGE_SIZE + 1)) as MessageJoinRow[]

    const hasMore = rows.length > PAGE_SIZE
    let messageRows = rows.slice(0, PAGE_SIZE)
    if (direction === 'forward') {
      messageRows = messageRows.reverse()
    }

    const messageIds = messageRows.map((r) => r.id)
    const parentIds = messageRows
      .filter((r) => r.parentId && r.alsoSendToChannel)
      .map((r) => r.parentId) as string[]

    const { reactionsByMessage, attachmentsMap } =
      await this.fetchMetadataForMessages(messageIds, parentIds)

    const formattedMessages = await Promise.all(
      messageRows.map((row) =>
        this.formatMessageRow(row, reactionsByMessage, attachmentsMap),
      ),
    )

    const result = this.buildMessagesResponse(
      formattedMessages,
      messageRows,
      hasMore,
      direction,
      cursor,
    )

    // Lưu cache chỉ cho page 1 (không cursor)
    if (!cursor) {
      await this.redis.set(
        this.messageCacheKey(targetId),
        JSON.stringify(result),
        MESSAGE_CACHE_TTL,
      )
    }

    return result
  }

  /**
   * getThreadMessages — lấy danh sách reply trong một thread
   * Phân trang theo cursor (createdAt) tương tự getMessages.
   */
  async getThreadMessages(
    parentId: string,
    userId: string,
    cursor?: string,
    direction: 'forward' | 'backward' = 'backward',
  ) {
    // 1. Lấy tin nhắn cha để biết channelId/conversationId
    const [parent] = await this.db
      .select({
        channelId: messages.channelId,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, parentId))
      .limit(1)

    if (!parent) throw new NotFoundException('Parent message not found')

    // 2. Kiểm tra quyền truy cập
    let workspaceId: string
    if (parent.channelId) {
      const ch = await this.assertChannelAccess(parent.channelId, userId)
      workspaceId = ch.workspaceId
    } else {
      const conv = await this.assertConversationAccess(
        parent.conversationId!,
        userId,
      )
      workspaceId = conv.workspaceId
    }

    // 3. Query replies
    let cursorDate: Date | undefined
    let cursorId: string | undefined
    if (cursor) {
      const parts = cursor.split('|')
      cursorDate = new Date(parts[0])
      cursorId = parts.length > 1 ? parts[1] : undefined
      if (cursorDate && isNaN(cursorDate.getTime())) cursorDate = undefined
    }

    const whereConditions = cursorDate
      ? and(
          eq(messages.parentId, parentId),
          direction === 'forward'
            ? cursorId
              ? or(
                  gt(messages.createdAt, cursorDate),
                  and(
                    eq(messages.createdAt, cursorDate),
                    gt(messages.id, cursorId),
                  ),
                )
              : gt(messages.createdAt, cursorDate)
            : cursorId
              ? or(
                  lt(messages.createdAt, cursorDate),
                  and(
                    eq(messages.createdAt, cursorDate),
                    lt(messages.id, cursorId),
                  ),
                )
              : lt(messages.createdAt, cursorDate),
        )
      : eq(messages.parentId, parentId)

    const rows = (await this.db
      .select(this.getMessageSelectFields())
      .from(messages)
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .leftJoin(
        sql`${messages} AS parents`,
        eq(messages.parentId, sql`parents.id`),
      )
      .where(whereConditions)
      .orderBy(
        ...(direction === 'forward'
          ? [asc(messages.createdAt), asc(messages.id)]
          : [desc(messages.createdAt), desc(messages.id)]),
      )
      .limit(PAGE_SIZE + 1)) as MessageJoinRow[]

    const hasMore = rows.length > PAGE_SIZE
    let messageRows = rows.slice(0, PAGE_SIZE)
    if (direction === 'forward') {
      messageRows = messageRows.reverse()
    }
    const messageIds = messageRows.map((r) => r.id)

    const { reactionsByMessage, attachmentsMap } =
      await this.fetchMetadataForMessages(messageIds)

    const formattedMessages = await Promise.all(
      messageRows.map((row) =>
        this.formatMessageRow(row, reactionsByMessage, attachmentsMap),
      ),
    )

    const lastMsg = messageRows[messageRows.length - 1]
    const firstMsg = messageRows[0]

    return {
      messages: formattedMessages,
      nextCursor:
        (direction === 'backward' && !hasMore) || messageRows.length === 0
          ? null
          : `${lastMsg.createdAt.toISOString()}|${lastMsg.id}`,
      prevCursor:
        !cursor ||
        (direction === 'forward' && !hasMore) ||
        messageRows.length === 0
          ? null
          : `${firstMsg.createdAt.toISOString()}|${firstMsg.id}`,
      hasMore,
    }
  }

  /**
   * buildMessagesResponse — helper tạo response object
   * Tách ra để type inference của cache hoạt động đúng
   */
  private buildMessagesResponse(
    formattedMessages: any[],
    messageRows: { id: string; createdAt: Date }[],
    hasMore: boolean,
    direction: 'forward' | 'backward',
    cursor?: string,
  ) {
    const lastMsg = messageRows[messageRows.length - 1]
    const firstMsg = messageRows[0]

    return {
      messages: formattedMessages,
      nextCursor:
        (direction === 'backward' && !hasMore) || messageRows.length === 0
          ? null
          : `${lastMsg.createdAt.toISOString()}|${lastMsg.id}`,
      prevCursor:
        !cursor ||
        (direction === 'forward' && !hasMore) ||
        messageRows.length === 0
          ? null
          : `${firstMsg.createdAt.toISOString()}|${firstMsg.id}`,
      hasMore,
    }
  }

  async createMessage(
    params: { channelId?: string; conversationId?: string },
    userId: string,
    dto: CreateMessageDto,
    options?: {
      forwardSnapshot?: Record<string, unknown> | null
      /** Mặc định message_body — forward copy từ nguồn dùng forward_quote */
      attachmentOriginScope?: 'message_body' | 'forward_quote'
    },
  ) {
    const { channelId, conversationId } = params
    const actualChannelId = channelId
    let actualConversationId = conversationId

    // Xử lý tạo conversation DM nếu chưa có (dành cho tin nhắn đầu tiên)
    if (
      !actualChannelId &&
      !actualConversationId &&
      dto.userIds &&
      dto.workspaceId
    ) {
      const conv = await this.db.transaction(async (tx) => {
        // 1. Chuẩn hóa danh sách User IDs: thêm bản thân, unique, sort
        const userIdsForSet = dto.userIds || []
        const allUserIds = Array.from(
          new Set([userId, ...userIdsForSet]),
        ).sort()
        const memberCount = allUserIds.length

        // 2. Tìm conversation hiện có chứa CHÍNH XÁC các thành viên này (đề phòng race condition)
        const existingConversation = await tx.execute(sql`
          SELECT cm.conversation_id
          FROM ${conversationMembers} cm
          JOIN ${directMessageConversations} dc ON dc.id = cm.conversation_id
          WHERE dc.workspace_id = ${dto.workspaceId}
            AND cm.user_id IN (${sql.join(
              allUserIds.map((id) => sql`${id}`),
              sql`, `,
            )})
          GROUP BY cm.conversation_id
          HAVING COUNT(DISTINCT cm.user_id) = ${memberCount}
             AND (SELECT COUNT(*) FROM ${conversationMembers} WHERE conversation_id = cm.conversation_id) = ${memberCount}
          LIMIT 1
        `)

        if (existingConversation.length > 0) {
          const row = existingConversation[0] as unknown as {
            conversation_id: string
          }
          return { id: row.conversation_id }
        }

        // 3. Tạo mới
        const isGroup = memberCount > 2
        const newConvId = randomUUID()
        await tx.insert(directMessageConversations).values({
          id: newConvId,
          workspaceId: dto.workspaceId!,
          isGroup,
        })

        const memberValues = allUserIds.map((uId) => ({
          id: randomUUID(),
          conversationId: newConvId,
          userId: uId,
        }))
        await tx.insert(conversationMembers).values(memberValues)

        return { id: newConvId }
      })
      actualConversationId = conv.id
    }

    const targetId = (actualChannelId || actualConversationId) as string

    let workspaceId: string
    if (actualChannelId) {
      const ch = await this.assertChannelAccess(actualChannelId, userId)
      workspaceId = ch.workspaceId
    } else {
      const conv = await this.assertConversationAccess(
        actualConversationId!,
        userId,
      )
      workspaceId = conv.workspaceId
    }

    let huddleSessionId: string | undefined
    if (dto.parentId) {
      const [par] = await this.db
        .select({
          type: messages.type,
          allowEdit: messages.allowEdit,
          parentId: messages.parentId,
          huddleSessionId: messages.huddleSessionId,
        })
        .from(messages)
        .where(eq(messages.id, dto.parentId))
        .limit(1)
      if (!par) {
        throw new NotFoundException('Parent message not found')
      }
      const isTimelineRoot =
        par.type === 'timeline' ||
        (par.type === 'text' && par.allowEdit === false && par.parentId == null)
      if (isTimelineRoot) {
        throw new BadRequestException('Cannot reply to this message')
      }
      // Copy huddleSessionId from parent message so replies are linked to the huddle
      huddleSessionId = par.huddleSessionId ?? undefined
    }

    if (actualChannelId) {
      const postingPermission = await this.getChannelPostingPermission(
        actualChannelId,
        userId,
      )
      const isThreadReply = Boolean(dto.parentId)
      if (isThreadReply) {
        if (!postingPermission.canReply) {
          throw new ForbiddenException(
            'Only certain people can reply in this channel',
          )
        }
        if (dto.alsoSendToChannel && !postingPermission.canSendToChannel) {
          throw new ForbiddenException(
            'Only certain people can post in this channel',
          )
        }
      } else if (!postingPermission.canPost) {
        throw new ForbiddenException(
          'Only certain people can post in this channel',
        )
      }
    }

    const { message, createdAttachments } = await this.db.transaction(
      async (tx) => {
        const [insertedMessage] = (await tx
          .insert(messages)
          .values({
            id: randomUUID(),
            channelId: actualChannelId ?? null,
            conversationId: actualConversationId ?? null,
            workspaceId, // Thêm workspaceId vào tin nhắn mới
            userId,
            content: dto.content,
            type: 'text',
            parentId: dto.parentId ?? null,
            huddleSessionId: huddleSessionId ?? null,
            alsoSendToChannel: dto.alsoSendToChannel ?? false,
            forwardSnapshot:
              options != null && 'forwardSnapshot' in options
                ? (options.forwardSnapshot ?? null)
                : null,
          })
          .returning()) as MessageJoinRow[]

        let insertedAttachments: any[] = []
        if (dto.attachments && dto.attachments.length > 0) {
          const attachmentValues = await Promise.all(
            dto.attachments.map((a) =>
              this.buildAttachmentInsertValue(a, {
                messageId: insertedMessage.id,
                workspaceId,
                userId,
                channelId: actualChannelId ?? null,
                conversationId: actualConversationId ?? null,
                originScope: options?.attachmentOriginScope ?? 'message_body',
              }),
            ),
          )
          insertedAttachments = await tx
            .insert(attachments)
            .values(attachmentValues)
            .returning()
        }

        return {
          message: insertedMessage,
          createdAttachments: insertedAttachments,
        }
      },
    )

    // Invalidate page 1 cache vì có message mới → cache cũ sẽ thiếu message này
    await this.redis.del(this.messageCacheKey(targetId))

    // Enqueue notification job (Background)
    this.logger.log(`Enqueuing notification job for message ${message.id}`)
    await this.notificationService.enqueueNotificationJob({
      messageId: message.id,
      senderId: userId,
      workspaceId,
      channelId: actualChannelId,
      conversationId: actualConversationId,
      content: dto.content,
      parentId: dto.parentId ?? null,
    })

    // Nếu là DM, cập nhật thông tin tin nhắn cuối cho conversation
    if (actualConversationId) {
      await this.db
        .update(directMessageConversations)
        .set({
          lastMessageAt: new Date(),
          lastMessageContent: dto.content,
          lastMessageUserId: userId,
          lastMessageId: message.id,
        })
        .where(eq(directMessageConversations.id, actualConversationId))
    }

    // Lấy danh sách thành viên trong conversation để broadcast tới room user:id
    let recipientIds: string[] = []
    if (actualConversationId) {
      const memberRows = await this.db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, actualConversationId))
      recipientIds = memberRows.map((m) => m.userId)
    }

    // Nếu là reply trong thread, cập nhật metadata cho tin nhắn cha
    let parentReplyCount = 0
    let parentReplyParticipantIds: string[] = []
    let parentContent: string | null = null
    let parentDeletedAt: Date | null = null
    if (dto.parentId) {
      const [updatedParent] = await this.db
        .update(messages)
        .set({
          replyCount: sql`${messages.replyCount} + 1`,
          lastReplyAt: new Date(),
        })
        .where(eq(messages.id, dto.parentId))
        .returning({
          replyCount: messages.replyCount,
          userId: messages.userId, // Tác giả tin nhắn gốc
          content: messages.content,
          deletedAt: messages.deletedAt,
        })
      parentReplyCount = updatedParent?.replyCount ?? 0
      parentContent = updatedParent?.content ?? null
      parentDeletedAt = updatedParent?.deletedAt ?? null

      // --- Thread Subscriptions Logic ---
      // 1. Subscribe cho người gửi reply (isReplier = true để update lastReadAt)
      await this.ensureThreadSubscription(
        userId,
        dto.parentId,
        workspaceId,
        true,
      )

      // 2. Subscribe cho tác giả tin nhắn gốc (nếu khác người gửi reply)
      if (updatedParent && updatedParent.userId !== userId) {
        await this.ensureThreadSubscription(
          updatedParent.userId,
          dto.parentId,
          workspaceId,
        )
      }

      // Lấy danh sách ID của những người đã tham gia thread (tối đa 5 người)
      const participants = await this.db
        .select({ userId: messages.userId })
        .from(messages)
        .where(eq(messages.parentId, dto.parentId))
        .groupBy(messages.userId)
        .limit(5)

      parentReplyParticipantIds = participants.map((p) => p.userId)

      // 3. Lấy danh sách tất cả người đăng ký thread để broadcast real-time
      const subscribers = await this.db
        .select({ userId: threadSubscriptions.userId })
        .from(threadSubscriptions)
        .where(eq(threadSubscriptions.parentMessageId, dto.parentId))

      recipientIds = Array.from(
        new Set([...recipientIds, ...subscribers.map((s) => s.userId)]),
      )

      await this.notificationService.createReplyNotifications({
        actorId: userId,
        workspaceId,
        messageId: message.id,
        parentMessageId: dto.parentId,
        channelId: actualChannelId ?? null,
        conversationId: actualConversationId ?? null,
      })
    }

    const user = await this.getAuthorProfileForWorkspace(userId, workspaceId)

    const enrichedAttachments = await Promise.all(
      createdAttachments.map((a) => this.enrichAttachmentWithSignedUrl(a)),
    )

    // Lấy attachments của tin nhắn cha nếu cần thiết cho alsoSendToChannel
    let parentAttachments: any[] = []
    if (dto.parentId && dto.alsoSendToChannel) {
      parentAttachments = await this.attachmentService
        .getAttachmentsByMessageIds([dto.parentId])
        .then((map) => map.get(dto.parentId!) ?? [])
      parentAttachments = await Promise.all(
        parentAttachments.map((a) => this.enrichAttachmentWithSignedUrl(a)),
      )
    }

    return {
      ...message,
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
      allowEdit: message.allowEdit ?? true,
      forwardSnapshot:
        (message as { forwardSnapshot?: unknown }).forwardSnapshot ??
        options?.forwardSnapshot ??
        null,
      user,
      reactions: [],
      attachments: enrichedAttachments,
      recipientIds, // Thêm vào để controller có thể dùng broadcast
      parentReplyCount, // Trả về để broadcast cập nhật UI
      parentReplyParticipantIds,
      parent:
        dto.parentId && dto.alsoSendToChannel
          ? {
              content: parentDeletedAt ? '' : (parentContent ?? ''),
              deletedAt: parentDeletedAt?.toISOString() ?? null,
              attachments: parentAttachments,
            }
          : undefined,
    }
  }

  /**
   * Forward a message to multiple channels / conversations in the same workspace.
   * Creates one new message per destination; each broadcast via controller.
   */
  async forwardMessages(
    sourceMessageId: string,
    userId: string,
    dto: ForwardMessageDto,
  ) {
    const src = await this.getMessageById(sourceMessageId, userId)
    if (src.deletedAt) {
      throw new BadRequestException('Cannot forward a deleted message')
    }

    const uniq: ForwardMessageDto['destinations'] = []
    const seen = new Set<string>()
    for (const d of dto.destinations) {
      const k =
        d.type === 'channel' ? `c:${d.channelId}` : `v:${d.conversationId}`
      if (seen.has(k)) continue
      seen.add(k)
      uniq.push(d)
    }

    let sourceWorkspaceId: string
    if (src.channelId) {
      const ch = await this.assertChannelAccess(src.channelId, userId)
      sourceWorkspaceId = ch.workspaceId
    } else {
      const conv = await this.assertConversationAccess(
        src.conversationId!,
        userId,
      )
      sourceWorkspaceId = conv.workspaceId
    }

    for (const d of uniq) {
      if (d.type === 'channel') {
        const ch = await this.assertChannelAccess(d.channelId, userId)
        if (ch.workspaceId !== sourceWorkspaceId) {
          throw new ForbiddenException(
            'Destination must be in the same workspace as the source message',
          )
        }
      } else {
        const c = await this.assertConversationAccess(d.conversationId, userId)
        if (c.workspaceId !== sourceWorkspaceId) {
          throw new ForbiddenException(
            'Destination must be in the same workspace as the source message',
          )
        }
      }
    }

    const commentaryRaw = (dto.commentary ?? '').trim()
    const commentaryHtml = commentaryRaw.length > 0 ? commentaryRaw : '<p></p>'

    const nestedSnap = this.parseNestedForwardSnapshot(src.forwardSnapshot)
    const isMixedForward =
      nestedSnap != null &&
      (this.hasMeaningfulForwarderText(src.content) ||
        this.hasBodyOwnedAttachments(src as Record<string, any>))

    const srcAtts = (src.attachments ?? []) as Array<Record<string, unknown>>
    const attSourceRows = isMixedForward
      ? srcAtts.filter(
          (a) => (a.originScope as string | undefined) !== 'forward_quote',
        )
      : srcAtts

    const attPayload = attSourceRows.map((a) => ({
      url: String(a.url),
      type: a.type as 'image' | 'video' | 'audio' | 'file',
      name: String(a.name),
      size: Number(a.size ?? 0),
      mimeType: (a.mimeType as string | undefined) ?? undefined,
      width: (a.width as number | undefined) ?? undefined,
      height: (a.height as number | undefined) ?? undefined,
      duration: (a.duration as number | undefined) ?? undefined,
      fileCategory: (a.fileCategory as string | undefined) ?? undefined,
    }))

    const createDto: CreateMessageDto = {
      content: commentaryHtml,
      ...(attPayload.length > 0 ? { attachments: attPayload } : {}),
    }

    const forwardSnapshotRecord = isMixedForward
      ? null
      : await this.resolveForwardSnapshotForOutgoingForward(
          src as Record<string, any>,
          userId,
        )

    const createOpts = isMixedForward
      ? {
          forwardSnapshot: null,
          attachmentOriginScope: 'message_body' as const,
        }
      : {
          forwardSnapshot: forwardSnapshotRecord,
          attachmentOriginScope: 'forward_quote' as const,
        }

    const results: object[] = []
    for (const d of uniq) {
      const params =
        d.type === 'channel'
          ? { channelId: d.channelId }
          : { conversationId: d.conversationId }
      const msg = await this.createMessage(
        params,
        userId,
        createDto,
        createOpts,
      )
      results.push(msg)
    }
    return results
  }

  private buildTimelineTextContent(
    kind:
      | 'channel_topic'
      | 'channel_description'
      | 'channel_posting_permissions'
      | 'channel_privacy'
      | 'dm_topic'
      | 'dm_description'
      | 'dm_merge'
      | 'dm_merged_out',
    value?: string | null,
  ): string {
    if (kind === 'dm_merged_out') {
      return 'Messages from this conversation were moved into your combined conversation.'
    }
    if (kind === 'dm_merge') {
      return 'Moved messages from a previous conversation into this one.'
    }
    if (kind === 'channel_posting_permissions') {
      return 'changed the channel posting permissions'
    }
    if (kind === 'channel_privacy') {
      return value === 'private'
        ? 'changed the channel to private'
        : 'changed the channel to public'
    }
    const scope = kind.startsWith('dm_') ? 'conversation' : 'channel'
    const isTopic = kind.endsWith('_topic')
    const v = value?.trim() ? value.trim() : null
    if (isTopic) {
      return v ? `set the ${scope} topic: ${v}` : `removed the ${scope} topic`
    }
    return v
      ? `set the ${scope} description: ${v}`
      : `removed the ${scope} description`
  }

  /**
   * Tin text do server (topic/description/merge), không enqueue notification, allow_edit = false.
   */
  async createTimelineTextMessage(
    params: { channelId?: string; conversationId?: string },
    actorUserId: string,
    kind:
      | 'channel_topic'
      | 'channel_description'
      | 'channel_posting_permissions'
      | 'channel_privacy'
      | 'dm_topic'
      | 'dm_description'
      | 'dm_merge'
      | 'dm_merged_out',
    value?: string | null,
  ) {
    const { channelId, conversationId } = params
    const content = this.buildTimelineTextContent(kind, value)
    const actualChannelId = channelId ?? null
    const actualConversationId = conversationId ?? null

    let workspaceId: string
    if (actualChannelId) {
      const ch = await this.assertChannelAccess(actualChannelId, actorUserId)
      workspaceId = ch.workspaceId
    } else if (actualConversationId) {
      const conv = await this.assertConversationAccess(
        actualConversationId,
        actorUserId,
      )
      workspaceId = conv.workspaceId
    } else {
      throw new BadRequestException('channelId or conversationId is required')
    }

    const targetId = (actualChannelId || actualConversationId) as string

    const [insertedMessage] = (await this.db
      .insert(messages)
      .values({
        id: randomUUID(),
        channelId: actualChannelId,
        conversationId: actualConversationId,
        workspaceId,
        userId: actorUserId,
        content,
        type: 'timeline',
        parentId: null,
        alsoSendToChannel: false,
        allowEdit: false,
      })
      .returning()) as MessageJoinRow[]

    await this.redis.del(this.messageCacheKey(targetId))

    if (actualConversationId) {
      await this.db
        .update(directMessageConversations)
        .set({
          lastMessageAt: new Date(),
          lastMessageContent: content,
          lastMessageUserId: actorUserId,
          lastMessageId: insertedMessage.id,
        })
        .where(eq(directMessageConversations.id, actualConversationId))
    }

    let recipientIds: string[] = []
    if (actualConversationId) {
      const memberRows = await this.db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, actualConversationId))
      recipientIds = memberRows.map((m) => m.userId)
    }

    const user = await this.getAuthorProfileForWorkspace(
      actorUserId,
      workspaceId,
    )
    const message = insertedMessage

    return {
      ...message,
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
      allowEdit: message.allowEdit ?? false,
      user,
      reactions: [] as { emoji: string; count: number; userIds: string[] }[],
      attachments: [],
      recipientIds,
      parentReplyCount: 0,
      parentReplyParticipantIds: [] as string[],
      workspaceId,
    }
  }

  /**
   * Lấy danh sách ID người dùng cần nhận broadcast cho một tin nhắn (hoặc thread)
   */
  async getRecipientIds(
    messageId: string,
    parentId?: string | null,
  ): Promise<{ recipientIds: string[]; workspaceId: string }> {
    let recipientIds: string[] = []
    let workspaceId: string = ''

    // 1. Lấy workspaceId từ message, kèm theo conversationId
    const [msg] = await this.db
      .select({
        conversationId: messages.conversationId,
        workspaceId: messages.workspaceId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)

    if (!msg) return { recipientIds, workspaceId }

    workspaceId = msg.workspaceId || ''

    if (msg.conversationId) {
      const members = await this.db
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(eq(conversationMembers.conversationId, msg.conversationId))
      recipientIds = members.map((m) => m.userId)
    }

    // 2. Nếu thuộc thread, lấy tất cả người đã subscribe thread đó
    const threadId =
      parentId ||
      (
        await this.db
          .select({ parentId: messages.parentId })
          .from(messages)
          .where(eq(messages.id, messageId))
          .limit(1)
      )[0]?.parentId

    if (threadId) {
      const subscribers = await this.db
        .select({ userId: threadSubscriptions.userId })
        .from(threadSubscriptions)
        .where(eq(threadSubscriptions.parentMessageId, threadId))

      const subscriberIds = subscribers.map((s) => s.userId)
      recipientIds = Array.from(new Set([...recipientIds, ...subscriberIds]))
    }

    return { recipientIds, workspaceId }
  }

  /**
   * getMessageById — lấy một message cụ thể với full data (user, reactions, attachments)
   * Dùng sau khi client upload attachments xong để fetch lại message đầy đủ.
   */
  async getMessageById(messageId: string, userId: string) {
    // Lấy message + user info
    const [row] = (await this.db
      .select({
        ...this.getMessageSelectFields(),
        workspaceId: sql<string>`COALESCE(${channels.workspaceId}, ${directMessageConversations.workspaceId})`,
        channelName: channels.name,
      })
      .from(messages)
      .leftJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(
        directMessageConversations,
        eq(messages.conversationId, directMessageConversations.id),
      )
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(
            workspaceMembers.workspaceId,
            sql`COALESCE(${channels.workspaceId}, ${directMessageConversations.workspaceId})`,
          ),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .leftJoin(
        sql`${messages} AS parents`,
        eq(messages.parentId, sql`parents.id`),
      )
      .where(eq(messages.id, messageId))
      .limit(1)) as (MessageJoinRow & { workspaceId: string })[]

    if (!row) {
      throw new NotFoundException('Message not found')
    }

    // Check access
    if (row.channelId) {
      await this.assertChannelAccess(row.channelId, userId)
    } else if (row.conversationId) {
      await this.assertConversationAccess(row.conversationId, userId)
    }

    const [recipientIds, { reactionsByMessage, attachmentsMap }] =
      await Promise.all([
        this.getRecipientIds(messageId, row.parentId),
        this.fetchMetadataForMessages(
          [messageId],
          row.parentId ? [row.parentId] : [],
        ),
      ])

    const formatted = await this.formatMessageRow(
      row,
      reactionsByMessage,
      attachmentsMap,
    )
    return { ...formatted, recipientIds }
  }

  async getMessagesByIds(messageIds: string[], userId: string) {
    if (messageIds.length === 0) return new Map<string, any>()

    // 1. Fetch all message rows with joins
    const rows = (await this.db
      .select({
        ...this.getMessageSelectFields(),
        workspaceId: sql<string>`COALESCE(${channels.workspaceId}, ${directMessageConversations.workspaceId})`,
        channelName: channels.name,
      })
      .from(messages)
      .leftJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(
        directMessageConversations,
        eq(messages.conversationId, directMessageConversations.id),
      )
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(
            workspaceMembers.workspaceId,
            sql`COALESCE(${channels.workspaceId}, ${directMessageConversations.workspaceId})`,
          ),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .leftJoin(
        sql`${messages} AS parents`,
        eq(messages.parentId, sql`parents.id`),
      )
      .where(inArray(messages.id, messageIds))) as (MessageJoinRow & {
      workspaceId: string
    })[]

    if (rows.length === 0) return new Map<string, any>()

    // 2. Check access for unique channels and conversations
    const channelIds = [
      ...new Set(rows.map((r) => r.channelId).filter(Boolean)),
    ] as string[]
    const conversationIds = [
      ...new Set(rows.map((r) => r.conversationId).filter(Boolean)),
    ] as string[]

    await Promise.all([
      ...channelIds.map((id) => this.assertChannelAccess(id, userId)),
      ...conversationIds.map((id) => this.assertConversationAccess(id, userId)),
    ])

    // 3. Fetch metadata in bulk
    const parentIds = rows.map((r) => r.parentId).filter(Boolean) as string[]
    const { reactionsByMessage, attachmentsMap } =
      await this.fetchMetadataForMessages(
        rows.map((r) => r.id),
        parentIds,
      )

    // 4. Format all rows
    const formattedMessages = await Promise.all(
      rows.map((row) =>
        this.formatMessageRow(row, reactionsByMessage, attachmentsMap),
      ),
    )

    return new Map(formattedMessages.map((m) => [m.id, m]))
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
        wmId: workspaceMembers.id,
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

    const isRemovedWorkspaceMember = row.wmId == null
    const name = isRemovedWorkspaceMember
      ? 'deactivated user'
      : (row.wmName ?? row.accountName ?? null)
    const avatar = isRemovedWorkspaceMember
      ? null
      : (row.wmAvatar ?? row.accountAvatar ?? null)
    const profile = {
      id: row.id,
      name,
      avatar,
      email: isRemovedWorkspaceMember ? '' : row.email,
      displayName: isRemovedWorkspaceMember
        ? 'deactivated user'
        : (row.displayName ?? name),
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
        allowEdit: messages.allowEdit,
        channelId: messages.channelId,
        conversationId: messages.conversationId,
        workspaceId: sql<string>`COALESCE(${channels.workspaceId}, ${directMessageConversations.workspaceId})`,
        type: messages.type,
      })
      .from(messages)
      .leftJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(
        directMessageConversations,
        eq(messages.conversationId, directMessageConversations.id),
      )
      .where(eq(messages.id, messageId))
      .limit(1)) as Array<{
      id: string
      userId: string
      deletedAt: Date | null
      allowEdit: boolean
      channelId: string | null
      conversationId: string | null
      workspaceId: string
      type: string
    }>

    if (!message) throw new NotFoundException('Message not found')
    if (message.userId !== userId)
      throw new ForbiddenException('Not your message')
    if (message.type === 'huddle')
      throw new ForbiddenException('This message cannot be edited')
    if (message.deletedAt)
      throw new ForbiddenException('Cannot edit deleted message')
    if (message.allowEdit === false)
      throw new ForbiddenException('This message cannot be edited')

    const targetId = (message.channelId || message.conversationId) as string
    const workspaceId = message.workspaceId

    const attachmentsToDelete =
      dto.deletedAttachmentIds && dto.deletedAttachmentIds.length > 0
        ? ((await this.db
            .select({
              id: attachments.id,
              url: attachments.url,
              type: attachments.type,
            })
            .from(attachments)
            .where(
              and(
                inArray(attachments.id, dto.deletedAttachmentIds),
                eq(attachments.messageId, messageId),
                ne(attachments.originScope, 'forward_quote'),
              ),
            )) as Array<{
            id: string
            url: string
            type: string
          }>)
        : []

    if (attachmentsToDelete.length > 0) {
      await this.attachmentService.deleteAttachmentStorageBatch(
        attachmentsToDelete,
      )
    }

    await this.db.transaction(async (tx) => {
      let insertedAttachments: Array<{
        id: string
      }> = []
      // 1. Xóa attachments nếu có yêu cầu
      if (dto.deletedAttachmentIds && dto.deletedAttachmentIds.length > 0) {
        await tx
          .delete(attachments)
          .where(
            and(
              inArray(attachments.id, dto.deletedAttachmentIds),
              eq(attachments.messageId, messageId),
              ne(attachments.originScope, 'forward_quote'),
            ),
          )
      }

      // 2. Thêm attachments mới nếu có
      if (dto.attachments && dto.attachments.length > 0) {
        const attachmentValues = await Promise.all(
          dto.attachments.map((a) =>
            this.buildAttachmentInsertValue(a, {
              messageId,
              workspaceId,
              userId,
              channelId: message.channelId,
              conversationId: message.conversationId,
              originScope: 'message_body',
            }),
          ),
        )
        insertedAttachments = await tx
          .insert(attachments)
          .values(attachmentValues)
          .returning({
            id: attachments.id,
          })
      }

      // 3. Cập nhật nội dung tin nhắn
      const [updatedMessage] = (await tx
        .update(messages)
        .set({
          content:
            dto.content !== undefined ? dto.content : sql`${messages.content}`,
          editedAt: new Date(),
        })
        .where(eq(messages.id, messageId))
        .returning()) as Array<{
        id: string
        channelId: string | null
        conversationId: string | null
        userId: string
        content: string
        type: string
        parentId: string | null
        editedAt: Date | null
        deletedAt: Date | null
        createdAt: Date
        updatedAt: Date
      }>

      // 4. Kiểm tra xem tin nhắn có bị rỗng không (không content + không attachments)
      const remainingAttachments = await tx
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.messageId, messageId))

      if (
        (!updatedMessage.content || updatedMessage.content.trim() === '') &&
        remainingAttachments.length === 0
      ) {
        throw new ForbiddenException(
          'Message cannot be empty (no content and no attachments)',
        )
      }

      return { updatedMessage, insertedAttachments }
    })

    // Invalidate cache
    await this.redis.del(this.messageCacheKey(targetId))

    // Trả về full message (kèm user, attachments) để broadcast có đầy đủ data

    return this.getMessageById(messageId, userId)
  }

  /** deleteMessage — soft delete, không xóa khỏi DB */
  async deleteMessage(messageId: string, userId: string) {
    const [message] = (await this.db
      .select({
        id: messages.id,
        userId: messages.userId,
        workspaceId: messages.workspaceId,
        channelId: messages.channelId,
        conversationId: messages.conversationId,
        parentId: messages.parentId,
        type: messages.type,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)) as Array<{
      id: string
      userId: string
      workspaceId: string | null
      channelId: string | null
      conversationId: string | null
      parentId: string | null
      type: string
    }>

    if (!message) throw new NotFoundException('Message not found')
    if (message.userId !== userId)
      throw new ForbiddenException('Not your message')
    if (message.type === 'huddle')
      throw new ForbiddenException('This message cannot be deleted')
    if (message.workspaceId) {
      await this.permissionsService.requireUserPermission(
        message.workspaceId,
        userId,
        'delete_own_messages',
      )
    }

    const targetId = (message.channelId || message.conversationId) as string
    const room = message.channelId
      ? `channel:${message.channelId}`
      : `conversation:${message.conversationId}`

    await this.db
      .update(messages)
      .set({ deletedAt: new Date(), content: '' })
      .where(eq(messages.id, messageId))

    if (message.workspaceId) {
      await this.laterService.purgeAllItemsForMessage(
        message.workspaceId,
        messageId,
      )
    }

    // Invalidate cache vì message đã bị xóa (soft delete)
    await this.redis.del(this.messageCacheKey(targetId))

    return { messageId, room, deleted: true, parentId: message.parentId }
  }

  /** togglePin — ghim hoặc bỏ ghim tin nhắn */
  async togglePin(messageId: string, userId: string) {
    const [message] = (await this.db
      .select({
        id: messages.id,
        isPinned: messages.isPinned,
        channelId: messages.channelId,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)) as Array<{
      id: string
      isPinned: boolean
      channelId: string | null
      conversationId: string | null
      parentId: string | null
    }>

    if (!message) throw new NotFoundException('Message not found')

    // Kiểm tra quyền truy cập (phải là member của channel/conversation)
    if (message.channelId) {
      await this.assertChannelAccess(message.channelId, userId)
    } else if (message.conversationId) {
      await this.assertConversationAccess(message.conversationId, userId)
    }

    const newPinnedStatus = !message.isPinned
    const targetId = (message.channelId || message.conversationId) as string
    const room = message.channelId
      ? `channel:${message.channelId}`
      : `conversation:${message.conversationId}`

    await this.db
      .update(messages)
      .set({ isPinned: newPinnedStatus })
      .where(eq(messages.id, messageId))

    // Invalidate cache
    await this.redis.del(this.messageCacheKey(targetId))

    return {
      messageId,
      isPinned: newPinnedStatus,
      room,
      parentId: message.parentId,
    }
  }

  /** Lấy danh sách tin nhắn đã ghim */
  async getPinnedMessages(
    params: { channelId?: string; conversationId?: string },
    userId: string,
  ) {
    const { channelId, conversationId } = params
    let workspaceId: string

    if (channelId) {
      const ch = await this.assertChannelAccess(channelId, userId)
      workspaceId = ch.workspaceId
    } else {
      const conv = await this.assertConversationAccess(conversationId!, userId)
      workspaceId = conv.workspaceId
    }

    const rows = (await this.db
      .select(this.getMessageSelectFields())
      .from(messages)
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .leftJoin(
        sql`${messages} AS parents`,
        eq(messages.parentId, sql`parents.id`),
      )
      .where(
        and(
          channelId
            ? eq(messages.channelId, channelId)
            : eq(messages.conversationId, conversationId!),
          eq(messages.isPinned, true),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.createdAt))) as (MessageJoinRow & {
      isPinned: boolean
    })[]

    const messageIds = rows.map((r) => r.id)
    const parentIds = rows
      .filter((r) => r.parentId && r.alsoSendToChannel)
      .map((r) => r.parentId) as string[]

    const { reactionsByMessage, attachmentsMap } =
      await this.fetchMetadataForMessages(messageIds, parentIds)

    const formattedMessages = await Promise.all(
      rows.map((row) =>
        this.formatMessageRow(row, reactionsByMessage, attachmentsMap),
      ),
    )

    return formattedMessages
  }

  /** toggleReaction — thêm hoặc bỏ reaction
   * Nếu đã react với emoji này → bỏ (toggle)
   * Nếu chưa → thêm
   */
  async toggleReaction(messageId: string, userId: string, dto: AddReactionDto) {
    // Lấy channelId hoặc conversationId từ message để broadcast đúng room
    const [messageRow] = (await this.db
      .select({
        channelId: messages.channelId,
        conversationId: messages.conversationId,
        parentId: messages.parentId,
        workspaceId: messages.workspaceId,
        ownerUserId: messages.userId,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)) as Array<{
      channelId: string | null
      conversationId: string | null
      parentId: string | null
      workspaceId: string
      ownerUserId: string
    }>

    if (!messageRow) throw new NotFoundException('Message not found')

    const room = messageRow.channelId
      ? `channel:${messageRow.channelId}`
      : `conversation:${messageRow.conversationId}`

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
      const { reactionsByMessage } = await this.fetchMetadataForMessages([
        messageId,
      ])
      return {
        action: 'removed',
        emoji: dto.emoji,
        room,
        parentId: messageRow.parentId,
        reactions: reactionsByMessage[messageId] ?? [],
      }
    } else {
      await this.db.insert(reactions).values({
        id: randomUUID(),
        messageId,
        userId,
        emoji: dto.emoji,
      })
      await this.notificationService.createReactionNotification({
        actorId: userId,
        workspaceId: messageRow.workspaceId,
        messageId,
        ownerUserId: messageRow.ownerUserId,
        channelId: messageRow.channelId,
        conversationId: messageRow.conversationId,
      })
      const { reactionsByMessage } = await this.fetchMetadataForMessages([
        messageId,
      ])
      return {
        action: 'added',
        emoji: dto.emoji,
        room,
        parentId: messageRow.parentId,
        reactions: reactionsByMessage[messageId] ?? [],
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

  async assertRealtimeWorkspaceAccess(workspaceId: string, userId: string) {
    await this.assertWorkspaceAccess(workspaceId, userId)
  }

  async assertRealtimeChannelAccess(channelId: string, userId: string) {
    await this.assertChannelAccess(channelId, userId)
  }

  async assertRealtimeConversationAccess(
    conversationId: string,
    userId: string,
  ) {
    await this.assertConversationAccess(conversationId, userId)
  }

  async assertRealtimeThreadAccess(parentMessageId: string, userId: string) {
    const [parent] = await this.db
      .select({
        channelId: messages.channelId,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, parentMessageId))
      .limit(1)

    if (!parent) throw new NotFoundException('Parent message not found')

    if (parent.channelId) {
      await this.assertChannelAccess(parent.channelId, userId)
      return
    }

    if (parent.conversationId) {
      await this.assertConversationAccess(parent.conversationId, userId)
      return
    }

    throw new NotFoundException('Thread target not found')
  }

  private async assertTargetAccess(
    target: { channelId?: string; conversationId?: string },
    userId: string,
  ) {
    if (target.channelId) {
      const ch = await this.assertChannelAccess(target.channelId, userId)
      return { workspaceId: ch.workspaceId }
    }
    if (target.conversationId) {
      const conv = await this.assertConversationAccess(
        target.conversationId,
        userId,
      )
      return { workspaceId: conv.workspaceId }
    }
    throw new NotFoundException('Target not specified')
  }

  private normalizedContentExpr(messageTable = messages) {
    return sql<string>`
      trim(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                COALESCE(${messageTable.content}, ''),
                '<a[^>]*href\\s*=\\s*["'']([^"'']+)["''][^>]*>',
                ' \\1 ',
                'gi'
              ),
              '<[^>]+>',
              ' ',
              'g'
            ),
            '&nbsp;',
            ' ',
            'g'
          ),
          '[[:space:]]+',
          ' ',
          'g'
        )
      )
    `
  }

  async searchWorkspaceMessages(
    workspaceId: string,
    userId: string,
    dto: SearchWorkspaceMessagesDto,
  ) {
    await this.assertWorkspaceAccess(workspaceId, userId)

    const trimmedQuery = dto.q?.trim()
    const hasTextQuery = Boolean(trimmedQuery)
    const normalizedContent = this.normalizedContentExpr(messages)
    const escapedLikeQuery = trimmedQuery
      ? `%${trimmedQuery.replace(/[\\%_]/g, '\\$&')}%`
      : null
    const tsQuery = hasTextQuery
      ? sql`websearch_to_tsquery('simple', ${trimmedQuery!})`
      : null
    const tsVector = sql`to_tsvector('simple', ${normalizedContent})`
    const rankExpr = hasTextQuery
      ? sql<number>`ts_rank_cd(${tsVector}, ${tsQuery!})`
      : sql<number | null>`NULL`
    const excerptExpr = hasTextQuery
      ? sql<string>`
          ts_headline(
            'simple',
            ${normalizedContent},
            ${tsQuery!},
            'MaxFragments=2, MaxWords=18, MinWords=8, StartSel=<mark>, StopSel=</mark>'
          )
        `
      : sql<string>`left(${normalizedContent}, 240)`

    const conditions = [
      eq(messages.workspaceId, workspaceId),
      isNull(messages.deletedAt),
      ne(messages.type, 'system'),
      ne(messages.type, 'timeline'),
      or(
        and(
          sql`${messages.channelId} IS NOT NULL`,
          eq(channels.isPrivate, false),
        ),
        sql`EXISTS (
          SELECT 1
          FROM channel_members cm_visible
          WHERE cm_visible.channel_id = ${messages.channelId}
            AND cm_visible.user_id = ${userId}
        )`,
        sql`EXISTS (
          SELECT 1
          FROM conversation_members conv_visible
          WHERE conv_visible.conversation_id = ${messages.conversationId}
            AND conv_visible.user_id = ${userId}
        )`,
      ),
      hasTextQuery
        ? or(
            sql`${tsVector} @@ ${tsQuery!}`,
            sql`${normalizedContent} ILIKE ${escapedLikeQuery!} ESCAPE '\'`,
          )
        : undefined,
      dto.fromUserIds.length > 0
        ? inArray(messages.userId, dto.fromUserIds)
        : undefined,
      dto.channelIds.length > 0 && dto.conversationIds.length > 0
        ? or(
            inArray(messages.channelId, dto.channelIds),
            inArray(messages.conversationId, dto.conversationIds),
          )
        : dto.channelIds.length > 0
          ? inArray(messages.channelId, dto.channelIds)
          : dto.conversationIds.length > 0
            ? inArray(messages.conversationId, dto.conversationIds)
            : undefined,
      dto.afterDate
        ? sql`${messages.createdAt} >= (${dto.afterDate}::date)`
        : undefined,
      dto.beforeDate
        ? sql`${messages.createdAt} < (${dto.beforeDate}::date + INTERVAL '1 day')`
        : undefined,
      dto.has.includes('file')
        ? sql`EXISTS (
            SELECT 1
            FROM attachments a_file
            WHERE a_file.message_id = ${messages.id}
          )`
        : undefined,
      dto.has.includes('link')
        ? or(
            sql`${messages.content} ~* '<a\\s[^>]*href\\s*='`,
            sql`${this.normalizedContentExpr()} ~* '(^|[[:space:]])((https?://)|(www\\.))[[:graph:]]+'`,
          )
        : undefined,
      dto.has.includes('reaction')
        ? sql`EXISTS (
            SELECT 1
            FROM reactions r_search
            WHERE r_search.message_id = ${messages.id}
          )`
        : undefined,
      dto.types.length > 0
        ? (() => {
            const fileCategories = dto.types.flatMap((type) => {
              switch (type) {
                case 'documents':
                  return ['document']
                case 'spreadsheets':
                  return ['spreadsheet']
                case 'presentations':
                  return ['presentation']
                case 'pdfs':
                  return ['pdf']
                case 'audio':
                  return ['audio']
                case 'images':
                  return ['image']
                case 'videos':
                  return ['video']
                case 'snippets':
                  return ['code']
                default:
                  return []
              }
            })
            return sql`EXISTS (
              SELECT 1
              FROM attachments a_type
              WHERE a_type.message_id = ${messages.id}
                AND a_type.file_category IN (${sql.join(
                  fileCategories.map((category) => sql`${category}`),
                  sql`, `,
                )})
            )`
          })()
        : undefined,
      dto.is.includes('dm')
        ? sql`${messages.conversationId} IS NOT NULL`
        : undefined,
      dto.is.includes('thread')
        ? or(sql`${messages.parentId} IS NOT NULL`, gt(messages.replyCount, 0))
        : undefined,
      dto.is.includes('saved')
        ? sql`EXISTS (
            SELECT 1
            FROM saved_items s_saved
            WHERE s_saved.user_id = ${userId}
              AND s_saved.workspace_id = ${workspaceId}
              AND s_saved.type = 'message'
              AND s_saved.status = 'in_progress'
              AND s_saved.message_id = ${messages.id}
          )`
        : undefined,
      dto.is.includes('pinned') ? eq(messages.isPinned, true) : undefined,
      dto.withUserIds.length > 0
        ? or(
            and(
              sql`${messages.conversationId} IS NOT NULL`,
              ...dto.withUserIds.map(
                (withUserId) => sql`EXISTS (
                  SELECT 1
                  FROM conversation_members conv_with
                  WHERE conv_with.conversation_id = ${messages.conversationId}
                    AND conv_with.user_id = ${withUserId}
                )`,
              ),
            ),
            and(
              sql`${messages.channelId} IS NOT NULL`,
              ...dto.withUserIds.map(
                (withUserId) => sql`EXISTS (
                  SELECT 1
                  FROM messages m_with
                  WHERE COALESCE(m_with.parent_id, m_with.id) = COALESCE(${messages.parentId}, ${messages.id})
                    AND m_with.user_id = ${withUserId}
                )`,
              ),
            ),
          )
        : undefined,
    ]

    const whereExpr = and(...conditions)

    const countQuery = this.db
      .select({
        total: sql<number>`count(*)`,
      })
      .from(messages)
      .leftJoin(channels, eq(messages.channelId, channels.id))
      .where(whereExpr)

    const rowsQuery = this.db
      .select({
        ...this.getMessageSelectFields(),
        rank: rankExpr,
        excerpt: excerptExpr,
        channelName: channels.name,
        channelIsPrivate: channels.isPrivate,
        conversationIsGroup: directMessageConversations.isGroup,
        conversationLabel: sql<string | null>`
          CASE
            WHEN ${directMessageConversations.id} IS NULL THEN NULL
            ELSE (
              SELECT NULLIF(
                string_agg(
                  COALESCE(wm_conv.display_name, wm_conv.name, u_conv.name, u_conv.email),
                  ', '
                  ORDER BY COALESCE(wm_conv.display_name, wm_conv.name, u_conv.name, u_conv.email)
                ),
                ''
              )
              FROM conversation_members conv_label
              INNER JOIN users u_conv ON u_conv.id = conv_label.user_id
              LEFT JOIN workspace_members wm_conv
                ON wm_conv.workspace_id = ${workspaceId}
               AND wm_conv.user_id = conv_label.user_id
              WHERE conv_label.conversation_id = ${messages.conversationId}
                AND conv_label.user_id <> ${userId}
            )
          END
        `,
      })
      .from(messages)
      .leftJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(
        directMessageConversations,
        eq(messages.conversationId, directMessageConversations.id),
      )
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .leftJoin(
        sql`${messages} AS parents`,
        eq(messages.parentId, sql`parents.id`),
      )
      .where(whereExpr)

    const sort = dto.sort === 'relevance' && !hasTextQuery ? 'newest' : dto.sort

    const orderedRowsQuery =
      sort === 'relevance'
        ? rowsQuery.orderBy(
            desc(rankExpr),
            desc(messages.createdAt),
            desc(messages.id),
          )
        : sort === 'oldest'
          ? rowsQuery.orderBy(asc(messages.createdAt), asc(messages.id))
          : rowsQuery.orderBy(desc(messages.createdAt), desc(messages.id))

    const [[countRow], rows] = await Promise.all([
      countQuery,
      orderedRowsQuery.limit(dto.limit).offset(dto.offset),
    ])

    const pageRows = rows as WorkspaceMessageSearchRow[]
    const messageIds = pageRows.map((row) => row.id)
    const parentIds = pageRows
      .filter((row) => row.parentId && row.alsoSendToChannel)
      .map((row) => row.parentId) as string[]

    const { reactionsByMessage, attachmentsMap } =
      await this.fetchMetadataForMessages(messageIds, parentIds)

    const items = await Promise.all(
      pageRows.map(async (row) => {
        const message = await this.formatMessageRow(
          row,
          reactionsByMessage,
          attachmentsMap,
        )

        return {
          message,
          rank:
            row.rank == null || Number.isNaN(Number(row.rank))
              ? null
              : Number(row.rank),
          excerpt: row.excerpt || '',
          location: row.channelId
            ? {
                kind: 'channel' as const,
                channelId: row.channelId,
                channelName: row.channelName ?? 'Channel',
                isPrivate: Boolean(row.channelIsPrivate),
              }
            : {
                kind: 'conversation' as const,
                conversationId: row.conversationId!,
                conversationLabel:
                  row.conversationLabel?.trim() || 'Direct Message',
                isGroup: Boolean(row.conversationIsGroup),
              },
        }
      }),
    )

    const total = Number(countRow?.total ?? 0)

    return {
      items,
      total,
      limit: dto.limit,
      offset: dto.offset,
      hasMore: dto.offset + items.length < total,
    }
  }

  private async mapFileJoinRowsToHits(rows: ChannelFileJoinRow[]) {
    // Tối ưu: Lấy tất cả messageIds để fetch reactions/attachments nếu cần (hiện tại map từng row hơi chậm)
    // Tuy nhiên để giữ logic hiện tại là mỗi hit trả về 1 attachment + message info:
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
          conversationId: row.conversationId,
          content: row.deletedAt ? '' : row.content,
          type: row.type,
          parentId: row.parentId,
          alsoSendToChannel: row.alsoSendToChannel,
          replyCount: row.replyCount,
          replyParticipantIds: row.replyParticipantIds,
          lastReplyAt: row.lastReplyAt?.toISOString() ?? null,
          editedAt: row.editedAt?.toISOString() ?? null,
          deletedAt: row.deletedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          isPinned: row.isPinned,
          allowEdit: row.allowEdit ?? true,
          user: {
            id: row.userId,
            name: row.userName,
            avatar: row.userAvatar,
            email: row.userEmail,
            displayName: row.userDisplayName,
            isAway: row.userIsAway,
            status: row.userStatus,
            statusText: row.userStatus,
            statusEmoji: row.userStatusEmoji,
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
   * Danh sách attachment chung cho Channel và DM (tab Files).
   */
  async listAttachments(
    target: { channelId?: string; conversationId?: string },
    userId: string,
    cursor?: string,
    limit = CHANNEL_FILES_PAGE_SIZE,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)

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

    const whereExpr = and(
      target.channelId
        ? eq(messages.channelId, target.channelId)
        : eq(messages.conversationId, target.conversationId!),
      isNull(messages.deletedAt),
      cursorCond,
    )

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
        conversationId: messages.conversationId,
        content: messages.content,
        type: messages.type,
        parentId: messages.parentId,
        alsoSendToChannel: messages.alsoSendToChannel,
        replyCount: messages.replyCount,
        replyParticipantIds: sql<string[]>`
          COALESCE(
            (
              SELECT array_agg(DISTINCT m2.user_id)
              FROM ${messages} m2
              WHERE m2.parent_id = ${messages.id}
            ),
            '{}'
          )
        `,
        lastReplyAt: messages.lastReplyAt,
        editedAt: messages.editedAt,
        deletedAt: messages.deletedAt,
        createdAt: messages.createdAt,
        updatedAt: messages.updatedAt,
        userId: users.id,
        userEmail: users.email,
        userName: removedAuthorNameExpr,
        userAvatar: removedAuthorAvatarExpr,
        userDisplayName: removedAuthorDisplayNameExpr,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userStatus: workspaceMembers.statusText,
        userStatusEmoji: workspaceMembers.statusEmoji,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userPhone: workspaceMembers.phone,
        userDescription: workspaceMembers.description,
        userTimeZone: workspaceMembers.timeZone,
        isPinned: messages.isPinned,
        allowEdit: messages.allowEdit,
      })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .where(whereExpr)
      .orderBy(desc(attachments.createdAt), desc(attachments.id))
      .limit(limit + 1)) as ChannelFileJoinRow[]

    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const results = await this.mapFileJoinRowsToHits(pageRows)

    const last = pageRows[pageRows.length - 1]
    const nextCursor =
      hasMore && last
        ? `${last.attCreatedAt.toISOString()}__${last.attId}`
        : null

    return { results, nextCursor, hasMore }
  }

  /**
   * ensureThreadSubscription — đảm bảo user đã subscribe vào một thread.
   * Cập nhật lastReadAt nếu là người vừa gửi reply.
   */
  async ensureThreadSubscription(
    userId: string,
    parentMessageId: string,
    workspaceId: string,
    isReplier = false,
  ) {
    const [existing] = await this.db
      .select({ id: threadSubscriptions.id })
      .from(threadSubscriptions)
      .where(
        and(
          eq(threadSubscriptions.userId, userId),
          eq(threadSubscriptions.parentMessageId, parentMessageId),
        ),
      )
      .limit(1)

    if (!existing) {
      await this.db.insert(threadSubscriptions).values({
        id: randomUUID(),
        userId,
        parentMessageId,
        workspaceId,
        lastReadAt: new Date(),
      })
    } else if (isReplier) {
      // Chỉ cập nhật lastReadAt nếu user là người vừa gửi reply
      await this.db
        .update(threadSubscriptions)
        .set({ lastReadAt: new Date() })
        .where(eq(threadSubscriptions.id, existing.id))
    }
  }

  /**
   * markThreadAsRead — Cập nhật lastReadAt cho một thread cụ thể của user.
   */
  async markThreadAsRead(parentMessageId: string, userId: string) {
    await this.db
      .update(threadSubscriptions)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(threadSubscriptions.userId, userId),
          eq(threadSubscriptions.parentMessageId, parentMessageId),
        ),
      )
  }

  /**
   * Tìm file đính kèm chung cho Channel và DM theo tên.
   */
  async searchFiles(
    target: { channelId?: string; conversationId?: string },
    userId: string,
    q: string,
    limit = 30,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)
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
        conversationId: messages.conversationId,
        content: messages.content,
        type: messages.type,
        parentId: messages.parentId,
        alsoSendToChannel: messages.alsoSendToChannel,
        replyCount: messages.replyCount,
        replyParticipantIds: sql<string[]>`
          COALESCE(
            (
              SELECT array_agg(DISTINCT m2.user_id)
              FROM ${messages} m2
              WHERE m2.parent_id = ${messages.id}
            ),
            '{}'
          )
        `,
        lastReplyAt: messages.lastReplyAt,
        editedAt: messages.editedAt,
        deletedAt: messages.deletedAt,
        createdAt: messages.createdAt,
        updatedAt: messages.updatedAt,
        userId: users.id,
        userEmail: users.email,
        userName: removedAuthorNameExpr,
        userAvatar: removedAuthorAvatarExpr,
        userDisplayName: removedAuthorDisplayNameExpr,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userStatus: workspaceMembers.statusText,
        userStatusEmoji: workspaceMembers.statusEmoji,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userPhone: workspaceMembers.phone,
        userDescription: workspaceMembers.description,
        userTimeZone: workspaceMembers.timeZone,
        isPinned: messages.isPinned,
        allowEdit: messages.allowEdit,
      })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .where(
        and(
          target.channelId
            ? eq(messages.channelId, target.channelId)
            : eq(messages.conversationId, target.conversationId!),
          isNull(messages.deletedAt),
          ilike(attachments.name, pattern),
        ),
      )
      .orderBy(desc(attachments.createdAt), desc(attachments.id))
      .limit(limit)) as ChannelFileJoinRow[]

    const results = await this.mapFileJoinRowsToHits(rows)

    return { results }
  }

  async listChannelAttachments(
    channelId: string,
    userId: string,
    cursor?: string,
    limit = CHANNEL_FILES_PAGE_SIZE,
  ) {
    return this.listAttachments({ channelId }, userId, cursor, limit)
  }

  async listConversationAttachments(
    conversationId: string,
    userId: string,
    cursor?: string,
    limit = CHANNEL_FILES_PAGE_SIZE,
  ) {
    return this.listAttachments({ conversationId }, userId, cursor, limit)
  }

  async searchChannelFiles(
    channelId: string,
    userId: string,
    q: string,
    limit = 30,
  ) {
    return this.searchFiles({ channelId }, userId, q, limit)
  }

  async searchConversationFiles(
    conversationId: string,
    userId: string,
    q: string,
    limit = 30,
  ) {
    return this.searchFiles({ conversationId }, userId, q, limit)
  }

  async listFolderAttachments(
    target: { channelId?: string; conversationId?: string },
    folderId: string,
    userId: string,
    cursor?: string,
    limit = CHANNEL_FILES_PAGE_SIZE,
  ) {
    // ... logic tương tự listAttachments nhưng thêm filter folderId
    await Promise.resolve() // Temporary to avoid lint error
    return { results: [], nextCursor: null, hasMore: false }
  }

  /**
   * getThreads — Lấy tất cả các thread mà user đã subscribe trong một workspace.
   * Sắp xếp theo lastReplyAt của tin nhắn gốc giảm dần.
   */
  async getThreads(workspaceId: string, userId: string, cursor?: string) {
    // 1. Query subscriptions join với parent messages
    const whereConditions = cursor
      ? and(
          eq(threadSubscriptions.userId, userId),
          eq(threadSubscriptions.workspaceId, workspaceId),
          lt(messages.lastReplyAt, new Date(cursor)),
        )
      : and(
          eq(threadSubscriptions.userId, userId),
          eq(threadSubscriptions.workspaceId, workspaceId),
        )

    const rows = (await this.db
      .select({
        ...this.getMessageSelectFields(),
        lastReadAt: threadSubscriptions.lastReadAt,
        channelName: channels.name,
        channelType: channels.type,
        channelIsPrivate: channels.isPrivate,
        isGroup: directMessageConversations.isGroup,
      })
      .from(threadSubscriptions)
      .innerJoin(messages, eq(threadSubscriptions.parentMessageId, messages.id))
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(
        directMessageConversations,
        eq(messages.conversationId, directMessageConversations.id),
      )
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .leftJoin(
        sql`${messages} AS parents`,
        eq(messages.parentId, sql`parents.id`),
      )
      .where(whereConditions)
      .orderBy(desc(messages.lastReplyAt))
      .limit(PAGE_SIZE + 1)) as (MessageJoinRow & {
      lastReadAt: Date
      channelName: string | null
      channelType: string | null
      channelIsPrivate: boolean | null
      isGroup: boolean | null
    })[]

    const hasMore = rows.length > PAGE_SIZE
    const threadRows = rows.slice(0, PAGE_SIZE)

    // 2. Fetch metadata (reactions, attachments) và replies cho các tin nhắn gốc này
    const messageIds = threadRows.map((r) => r.id)
    const { reactionsByMessage, attachmentsMap } =
      await this.fetchMetadataForMessages(messageIds)

    // 3. Format kết quả trả về
    const threads = await Promise.all(
      threadRows.map(async (row) => {
        const formatted = await this.formatMessageRow(
          row,
          reactionsByMessage,
          attachmentsMap,
        )

        // Lấy danh sách reply để hiển thị snippet (giống Slack)
        // Lấy tối đa 5 tin nhắn con mới nhất để làm snippet ban đầu
        const repliesPage = await this.getThreadMessages(row.id, userId)
        const allReplies = repliesPage.messages.reverse() // Đảo ngược để hiển thị theo thứ tự thời gian tăng dần

        // Chỉ lấy 4 tin nhắn con mới nhất cho snippet ban đầu
        const snippetReplies = allReplies.slice(-4)
        const hasMoreReplies = allReplies.length > 4 || repliesPage.hasMore

        // Lấy thông tin conversation members nếu là DM
        let conversationMembersData: any[] = []
        if (row.conversationId) {
          conversationMembersData = await this.db
            .select({
              id: users.id,
              name: users.name,
              displayName: workspaceMembers.displayName,
              avatar: users.avatar,
            })
            .from(conversationMembers)
            .innerJoin(users, eq(conversationMembers.userId, users.id))
            .leftJoin(
              workspaceMembers,
              and(
                eq(workspaceMembers.userId, users.id),
                eq(workspaceMembers.workspaceId, workspaceId),
              ),
            )
            .where(eq(conversationMembers.conversationId, row.conversationId))
        }

        return {
          ...formatted,
          lastReadAt: row.lastReadAt.toISOString(),
          isUnread: row.lastReplyAt ? row.lastReplyAt > row.lastReadAt : false,
          channel: row.channelId
            ? {
                id: row.channelId,
                name: row.channelName,
                type: row.channelType,
                isPrivate: row.channelIsPrivate,
              }
            : null,
          conversation: row.conversationId
            ? {
                id: row.conversationId,
                isGroup: row.isGroup,
                members: conversationMembersData,
              }
            : null,
          replies: snippetReplies,
          hasMoreReplies,
        }
      }),
    )

    return {
      threads,
      nextCursor: hasMore
        ? threadRows[threadRows.length - 1].lastReplyAt?.toISOString()
        : null,
      hasMore,
    }
  }
}
