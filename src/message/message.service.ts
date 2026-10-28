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
  isNotNull,
  isNull,
  lt,
  lte,
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
import type { FinalizeAttachmentDto } from './dto/finalize-attachment.dto'
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

// Display name + avatar cho author tuỳ theo trạng thái membership trong workspace.
//
// Khi user KHÔNG còn active trong workspace, message/reaction/group DM name hiển thị
// "Deactivated user" thay vì tên thật. Khi user được reactivate, name thật quay lại.
//
// - active:      tên thật (COALESCE từ workspace_members → users)
// - deactivated: "Deactivated user" (mask name + avatar)
// - deleted:     "Deleted user" (row không còn, chỉ xảy ra với data cũ pre-plan)
const maskedAuthorNameExpr = sql<
  string | null
>`CASE
  WHEN ${workspaceMembers.id} IS NULL THEN 'Deleted user'
  WHEN ${workspaceMembers.membershipStatus} = 'deactivated' THEN 'Deactivated user'
  ELSE COALESCE(${workspaceMembers.name}, ${users.name})
END`
const maskedAuthorDisplayNameExpr = sql<
  string | null
>`CASE
  WHEN ${workspaceMembers.id} IS NULL THEN 'Deleted user'
  WHEN ${workspaceMembers.membershipStatus} = 'deactivated' THEN 'Deactivated user'
  ELSE COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})
END`
const maskedAuthorAvatarExpr = sql<
  string | null
>`CASE
  WHEN ${workspaceMembers.id} IS NULL THEN NULL
  WHEN ${workspaceMembers.membershipStatus} = 'deactivated' THEN NULL
  ELSE COALESCE(${workspaceMembers.avatar}, ${users.avatar})
END`
const maskedAuthorStatusExpr = sql<
  'active' | 'deactivated' | 'deleted'
>`CASE
  WHEN ${workspaceMembers.id} IS NULL THEN 'deleted'
  WHEN ${workspaceMembers.membershipStatus} = 'deactivated' THEN 'deactivated'
  ELSE 'active'
END`

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
  userMembershipStatus?: 'active' | 'deactivated' | 'deleted' | null
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
  userMembershipStatus?: 'active' | 'deactivated' | 'deleted' | null
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
    T extends { url: string | null; name?: string },
  >(att: T): Promise<T> {
    // Pending upload: chưa có URL thật → trả về nguyên row, không cần sign.
    if (!att.url) return att
    const key = this.s3Service.parseS3KeyFromUrl(att.url)
    if (!key) {
      this.logger.debug(`[enrich] parseS3KeyFromUrl returned null for URL: ${att.url}`)
      return att
    }
    try {
      const signedUrl = await this.s3Service.getPresignedGetUrl(key, 86400, att.name)
      this.logger.debug(`[enrich] key="${key}" → URL length=${signedUrl.length}, first 120: ${signedUrl.substring(0, 120)}`)
      return { ...att, url: signedUrl }
    } catch (err) {
      this.logger.error(`[enrich] failed to generate signed URL: ${(err as Error).message}`)
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
   * resolveForwardedSourceUsers
   *
   * Resolve `sourceUser` cho tất cả các forwardSnapshot trong list messages.
   *
   * Vấn đề giải quyết:
   * Trước đây snapshot đông cứng full user object tại thời điểm forward. Khi user
   * bị hard-delete khỏi workspace_members SAU khi forward, snapshot vẫn giữ tên
   * và avatar cũ → bug UI: forwarded message hiển thị user đã xoá với tên thật.
   *
   * Hướng mới:
   * - Snapshot mới chỉ lưu `sourceMessageId` (xem resolveForwardSnapshotForOutgoingForward)
   * - Khi đọc list messages, lấy tất cả `sourceMessageId` thiếu `sourceUser` rồi
   *   query 1 lần (batch) với cùng CASE expressions (removedAuthor*) → luôn nhận
   *   name/avatar/status HIỆN TẠI của source author (deleted → "Deleted user")
   *
   * Tối ưu:
   * - 1 query SQL batch thay vì N+1
   * - Cache `getMessageById` tận dụng được (cùng formatMessageRow + CASE expressions)
   * - Backward-compat: snapshot CŨ đã có `sourceUser` đầy đủ → giữ nguyên,
   *   không cần query lại. Tránh breaking change với dữ liệu đã tồn tại.
   *
   * @param messages - List messages (sẽ mutate forwardSnapshot của từng message)
   * @returns void - mutate messages[i].forwardSnapshot.sourceUser
   */
  async resolveForwardedSources(
    msgs: Array<{ forwardSnapshot?: Record<string, unknown> | null }>,
  ): Promise<void> {
    return this.resolveForwardedSourceUsers(msgs)
  }

  private async resolveForwardedSourceUsers(
    msgs: Array<{ forwardSnapshot?: Record<string, unknown> | null }>,
  ): Promise<void> {
    if (!msgs || msgs.length === 0) return

    // Lấy tất cả sourceMessageId cần resolve (snapshot thiếu sourceUser hợp lệ)
    const idsToResolve: string[] = []
    const indexBySourceId = new Map<string, number[]>() // sourceId -> indices trong msgs
    for (let i = 0; i < msgs.length; i++) {
      const snap = msgs[i].forwardSnapshot
      if (!snap || typeof snap !== 'object') continue
      const sourceId =
        typeof snap.sourceMessageId === 'string'
          ? snap.sourceMessageId
          : null
      if (!sourceId) continue
      // Source user hợp lệ = object có membershipStatus (từ snapshot CŨ đã lưu)
      const sourceUser = snap.sourceUser
      const hasValidSourceUser =
        sourceUser &&
        typeof sourceUser === 'object' &&
        'membershipStatus' in (sourceUser as Record<string, unknown>)
      if (hasValidSourceUser) continue
      idsToResolve.push(sourceId)
      const list = indexBySourceId.get(sourceId) ?? []
      list.push(i)
      indexBySourceId.set(sourceId, list)
    }

    if (idsToResolve.length === 0) return

    // Batch fetch: 1 query duy nhất cho tất cả source messages.
    // Tận dụng CASE expressions (removedAuthor*) đã có ở trên file này.
    // workspace_id của message nằm ở channels.workspace_id hoặc
    // direct_message_conversations.workspace_id → dùng COALESCE qua LEFT JOIN.
    const rows = await this.db
      .select({
        id: messages.id,
        workspaceId: sql<
          string | null
        >`COALESCE(${channels.workspaceId}, ${directMessageConversations.workspaceId})`,
        userId: users.id,
        userEmail: users.email,
        userName: maskedAuthorNameExpr,
        userAvatar: maskedAuthorAvatarExpr,
        userDisplayName: maskedAuthorDisplayNameExpr,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userStatus: workspaceMembers.statusText,
        userStatusEmoji: workspaceMembers.statusEmoji,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userMembershipStatus: maskedAuthorStatusExpr,
      })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.userId))
      .leftJoin(channels, eq(channels.id, messages.channelId))
      .leftJoin(
        directMessageConversations,
        eq(directMessageConversations.id, messages.conversationId),
      )
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          sql`${workspaceMembers.workspaceId} = COALESCE(${channels.workspaceId}, ${directMessageConversations.workspaceId})`,
        ),
      )
      .where(inArray(messages.id, idsToResolve))

    // Map sourceId → sourceUser object (format giống MessageJoinRow.user)
    const sourceUserById = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const wsId = (row as { workspaceId: string | null }).workspaceId
      // Nếu không có workspaceId (orphan message), vẫn build user nhưng
      // membershipStatus fallback 'active' (giống formatMessageRow behavior).
      sourceUserById.set(row.id, {
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
        membershipStatus: row.userMembershipStatus ?? 'active',
        // Metadata giúp debug nếu cần
        _workspaceId: wsId,
      } as unknown as Record<string, unknown>)
    }

    // Gắn sourceUser vào từng snapshot theo index
    for (const [sourceId, indices] of indexBySourceId) {
      const sourceUser = sourceUserById.get(sourceId)
      // sourceUser có thể null nếu source message đã bị hard-delete
      // → FE fallback 'Deleted user'
      for (const idx of indices) {
        const snap = msgs[idx].forwardSnapshot as Record<string, unknown>
        snap.sourceUser = sourceUser ?? null
      }
    }
  }

  /**
   * formatMessagesAndResolveForwardSources
   *
   * Helper gộp 2 bước cho các list endpoints:
   * 1. Format tất cả rows qua formatMessageRow (Promise.all song song)
   * 2. Resolve sourceUser cho forwardSnapshot (1 batch query)
   *
   * Dùng ở mọi nơi trả về danh sách messages để đảm bảo snapshot forward
   * luôn có sourceUser mới nhất (deleted users → "Deleted user").
   */
  private async formatMessagesAndResolveForwardSources(
    rows: MessageJoinRow[],
    reactionsByMessage: Record<string, ReactionSnapshot[]>,
    attachmentsMap: Map<string, any[]>,
    viewerMutedMap: Map<string, boolean>,
  ): Promise<Array<{ id: string; forwardSnapshot?: Record<string, unknown> | null } & Record<string, any>>> {
    const formatted = await Promise.all(
      rows.map((row) =>
        this.formatMessageRow(
          row,
          reactionsByMessage,
          attachmentsMap,
          viewerMutedMap,
        ),
      ),
    )
    // Backward-compat: nếu snapshot đã có sourceUser hợp lệ → keep as is.
    // Nếu thiếu (snapshot MỚI chỉ có sourceMessageId) → batch query từ DB.
    await this.resolveForwardedSourceUsers(formatted)
    return formatted as Array<{ id: string; forwardSnapshot?: Record<string, unknown> | null } & Record<string, any>>
  }

  /**
   * resolveForwardSnapshotForOutgoingForward
   *
   * Đi theo chuỗi forward_snapshot tới message gốc (tối đa 10 bước) để xác định
   * message gốc cần snapshot khi tạo forward mới.
   *
   * Snapshot LƯU sourceUser đầy đủ (id/name/avatar/displayName/email/membershipStatus)
   * — đây là "immutable history" tại thời điểm forward. Lý do:
   *
   * 1. Forward snapshot là bản ghi lịch sử — phản ánh trạng thái user tại thời
   *    điểm forward, không phải hiện tại (giống Slack).
   * 2. Forward message phải tự render được khi source message bị xoá hoặc
   *    resolve lại qua query batch (resolveForwardedSourceUsers) gặp edge case.
   *
   * NOTE: Khi source author bị DEACTIVATED SAU khi forward:
   * - Snapshot cũ (post-revert) lưu tên thật → hiển thị tên thật (immutable)
   * - Đây là trade-off giữa "history immutable" và "mask theo state hiện tại"
   * - resolveForwardedSourceUsers check `'membershipStatus' in sourceUser`
   *   để quyết định query lại (snapshot cũ thiếu field → query lại với mask)
   *
   * Backward-compat: snapshot CŨ đã tồn tại trong DB có đủ sourceUser vẫn hoạt
   * động (resolveForwardedSourceUsers nhận diện "có membershipStatus → đã
   * resolve, không cần query lại").
   */
  private async resolveForwardSnapshotForOutgoingForward(
    src: Record<string, any>,
    _userId: string,
  ): Promise<Record<string, unknown>> {
    let current: Record<string, any> = src
    for (let i = 0; i < 10; i++) {
      const snap = this.parseNestedForwardSnapshot(current.forwardSnapshot)
      if (!snap) {
        // Đây là message gốc (không có nested snapshot) → trả về snapshot
        // immutable tại thời điểm forward, bao gồm cả sourceUser info.
        return {
          sourceMessageId: current.id as string,
          sourceUser: {
            id: current.userId,
            name: current.userName,
            avatar: current.userAvatar,
            displayName: current.userDisplayName,
            email: current.userEmail,
            membershipStatus: current.userMembershipStatus ?? 'active',
          },
          sourceContent: current.content as string,
          sourceEditedAt: current.editedAt ?? null,
        }
      }
      current = (await this.getMessageById(
        snap.sourceMessageId,
        _userId,
      )) as Record<string, any>
    }
    // Hết 10 bước vẫn chưa tới gốc → fallback trả sourceMessageId của
    // message hiện tại (an toàn).
    return {
      sourceMessageId: current.id as string,
      sourceUser: {
        id: current.userId,
        name: current.userName,
        avatar: current.userAvatar,
        displayName: current.userDisplayName,
        email: current.userEmail,
        membershipStatus: current.userMembershipStatus ?? 'active',
      },
      sourceContent: current.content as string,
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
      /**
       * URL thật của file đã upload (S3/Cloudinary).
       * OPTIONAL khi `pendingUpload=true` — lúc đó server lưu tạm với url rỗng,
       * client sẽ PATCH qua endpoint finalize sau khi upload xong.
       */
      url?: string | null
      type: string
      name: string
      size: number
      mimeType?: string | null
      width?: number | null
      height?: number | null
      duration?: number | null
      fileCategory?: string | null
      /** Client-generated uploadId, dùng để match attachment row khi finalize. */
      pendingUploadId?: string | null
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
    const attachmentUrl = attachment.url?.trim() ? attachment.url : ''
    let previewImageUrl: string | null = null
    let previewStatus: 'ready' | 'failed' | null = null
    let previewUpdatedAt: Date | null = null
    let previewErrorCode: string | null = null

    // Chỉ generate thumbnail khi đã có URL thật (skip khi pendingUpload).
    if (attachmentUrl && supportsOfficeThumbnail(fileCategory)) {
      try {
        const preview = await this.officeThumbnailGenerator.generateThumbnail({
          id: attachmentId,
          workspaceId: context.workspaceId,
          name: attachment.name,
          url: attachmentUrl,
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
      url: attachmentUrl,
      type: attachment.type,
      name: attachment.name,
      size: attachment.size,
      mimeType: attachment.mimeType,
      width: attachment.width,
      height: attachment.height,
      duration: attachment.duration,
      fileCategory,
      pendingUploadId: attachment.pendingUploadId?.trim() || null,
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
      userName: maskedAuthorNameExpr,
      userAvatar: maskedAuthorAvatarExpr,
      userDisplayName: maskedAuthorDisplayNameExpr,
      userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
      userStatus: workspaceMembers.statusText,
      userStatusEmoji: workspaceMembers.statusEmoji,
      userNamePronunciation: workspaceMembers.namePronunciation,
      userPhone: workspaceMembers.phone,
      userDescription: workspaceMembers.description,
      userTimeZone: workspaceMembers.timeZone,
      userMembershipStatus: maskedAuthorStatusExpr,
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
        userName: maskedAuthorNameExpr,
        userDisplayName: maskedAuthorDisplayNameExpr,
        userAvatar: maskedAuthorAvatarExpr,
      })
      .from(reactions)
      .innerJoin(messages, eq(reactions.messageId, messages.id))
      .innerJoin(users, eq(reactions.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, reactions.userId),
          eq(workspaceMembers.workspaceId, messages.workspaceId),
          // (dùng messages.createdAt làm proxy vì reactions không có createdAt).
        ),
      )
      .where(inArray(reactions.messageId, messageIds))) as ReactionSnapshotRow[]
  }

  /**
   * Resolve `viewerIsMuted` cho mỗi thread (parent message).
   * Trả về Map<parentMessageId, isMuted> cho viewer đang xem.
   * Messages không có parentId → không cần resolve (reply sẽ resolve theo parentId).
   */
  private async resolveViewerMutedByParent(
    parentMessageIds: string[],
    viewerId: string,
  ): Promise<Map<string, boolean>> {
    if (parentMessageIds.length === 0) return new Map()
    const rows = await this.db
      .select({
        parentMessageId: threadSubscriptions.parentMessageId,
        isMuted: threadSubscriptions.isMuted,
      })
      .from(threadSubscriptions)
      .where(
        and(
          eq(threadSubscriptions.userId, viewerId),
          inArray(threadSubscriptions.parentMessageId, parentMessageIds),
        ),
      )
    const map = new Map<string, boolean>()
    for (const r of rows) map.set(r.parentMessageId, r.isMuted)
    return map
  }

  private async formatMessageRow(
    row: MessageJoinRow,
    reactionsByMessage: Record<string, ReactionSnapshot[]>,
    attachmentsMap: Map<string, any[]>,
    viewerMutedMap?: Map<string, boolean>,
  ) {
    const atts = attachmentsMap.get(row.id) ?? []
    const enrichedAtts = await Promise.all(
      atts.map(async (a) => ({
        ...(await this.enrichAttachmentWithSignedUrl(a)),
        pendingUpload: Boolean(a.pendingUploadId),
      })),
    )

    // viewerIsMuted: chỉ resolve ở parent message (replies resolve theo parentId).
    const threadId = row.parentId ?? row.id
    const viewerIsMuted = viewerMutedMap?.get(threadId) ?? false

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
      viewerIsMuted,
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
        // null khi row JOIN không có (vd. searchWorkspaceMessages) → fallback 'active'
        membershipStatus: row.userMembershipStatus ?? 'active',
      },
      reactions: reactionsByMessage[row.id] ?? [],
      attachments: enrichedAtts,
      parent:
        row.parentId && row.alsoSendToChannel
          ? {
              content: row.parentDeletedAt ? '' : (row.parentContent ?? ''),
              deletedAt: row.parentDeletedAt?.toISOString() ?? null,
              attachments: await Promise.all(
                (attachmentsMap.get(row.parentId) ?? []).map(async (a) => ({
                  ...(await this.enrichAttachmentWithSignedUrl(a)),
                  pendingUpload: Boolean(a.pendingUploadId),
                })),
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
          // Soft delete: chỉ count rows CHƯA bị xoá
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
          // Soft delete: chỉ count rows CHƯA rời channel
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

    // LAZY CLEANUP: dọn các pending-upload messages quá cũ (> 30 phút).
    // Best-effort, fire-and-forget: chạy trước khi query để cache/response không bị nhiễm.
    // Không chờ (không await) để không block request.
    if (!cursor) {
      void this.cleanupStalePendingAttachments().catch(() => {})
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

    const viewerMutedMap = await this.resolveViewerMutedByParent(
      // Mỗi message resolve theo parentId (cho reply) hoặc theo id (cho parent).
      Array.from(
        new Set(messageRows.map((r) => r.parentId ?? r.id)),
      ),
      userId,
    )

    const formattedMessages = await this.formatMessagesAndResolveForwardSources(
      messageRows,
      reactionsByMessage,
      attachmentsMap,
      viewerMutedMap,
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

    // Tất cả replies thuộc cùng 1 thread → resolve 1 lần cho parentId.
    const viewerMutedMap = await this.resolveViewerMutedByParent(
      [parentId],
      userId,
    )

    const formattedMessages = await this.formatMessagesAndResolveForwardSources(
      messageRows,
      reactionsByMessage,
      attachmentsMap,
      viewerMutedMap,
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
          .returning()) as unknown as MessageJoinRow[]

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

    // Detect nếu có attachment đang pending upload (chưa có URL thật).
    // Nếu có → skip notification ngay, sẽ enqueue lại trong finalizeAttachment khi file cuối cùng xong.
    const hasPendingAttachments =
      dto.attachments?.some((a) => a.pendingUpload === true) ?? false

    if (hasPendingAttachments) {
      // Defer notification — sẽ enqueue trong finalizeAttachment khi tất cả file finalize xong.
      this.logger.log(
        `Deferring notification for message ${message.id} — ${dto.attachments!.length} pending attachment(s)`,
      )
    } else {
      // Enqueue notification job (Background) — text-only message hoặc file đã có URL thật.
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
    }

    // Nếu là DM, cập nhật thông tin tin nhắn cuối cho conversation
    // Skip thread replies - chỉ update last message cho tin ở main DM
    if (actualConversationId && !dto.parentId) {
      let lastMessageContent = dto.content

      // Nếu content là empty/null, lấy tên file đầu tiên từ attachments
      if (!lastMessageContent || lastMessageContent.trim() === '') {
        const [firstAttachment] = await this.db
          .select({ name: attachments.name })
          .from(attachments)
          .where(eq(attachments.messageId, message.id))
          .orderBy(asc(attachments.createdAt))
          .limit(1)

        if (firstAttachment?.name) {
          lastMessageContent = firstAttachment.name
        }
      }

      await this.db
        .update(directMessageConversations)
        .set({
          lastMessageAt: new Date(),
          lastMessageContent,
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

      // Skip reply notification nếu có pending attachment — sẽ gửi khi finalize xong.
      if (!hasPendingAttachments) {
        await this.notificationService.createReplyNotifications({
          actorId: userId,
          workspaceId,
          messageId: message.id,
          parentMessageId: dto.parentId,
          channelId: actualChannelId ?? null,
          conversationId: actualConversationId ?? null,
        })
      }
    }

    const user = await this.getAuthorProfileForWorkspace(userId, workspaceId)

    const enrichedAttachments = await Promise.all(
      createdAttachments.map(async (a) => ({
        ...(await this.enrichAttachmentWithSignedUrl(a)),
        pendingUpload: Boolean(a.pendingUploadId),
      })),
    )

    // Lấy attachments của tin nhắn cha nếu cần thiết cho alsoSendToChannel
    let parentAttachments: any[] = []
    if (dto.parentId && dto.alsoSendToChannel) {
      parentAttachments = await this.attachmentService
        .getAttachmentsByMessageIds([dto.parentId])
        .then((map) => map.get(dto.parentId!) ?? [])
      parentAttachments = await Promise.all(
        parentAttachments.map(async (a) => ({
          ...(await this.enrichAttachmentWithSignedUrl(a)),
          pendingUpload: Boolean(a.pendingUploadId),
        })),
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
      | 'channel_name'
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
    // Marker có cấu trúc cho phép frontend parse + i18n sang vi/en.
    // Format: `__TIMELINE__:<kind>:<value-or-empty>`
    // Frontend sẽ tìm marker này trong message.content và thay bằng
    // bản dịch tương ứng; nếu không có marker (legacy data) → fallback
    // raw content để không vỡ history.
    return `__TIMELINE__:${kind}:${value ?? ''}`
  }

  /**
   * Tin text do server (topic/description/merge), không enqueue notification, allow_edit = false.
   */
  async createTimelineTextMessage(
    params: { channelId?: string; conversationId?: string },
    actorUserId: string,
    kind:
      | 'channel_name'
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
      .returning()) as unknown as MessageJoinRow[]

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

    const [recipientIds, { reactionsByMessage, attachmentsMap }, viewerMutedMap] =
      await Promise.all([
        this.getRecipientIds(messageId, row.parentId),
        this.fetchMetadataForMessages(
          [messageId],
          row.parentId ? [row.parentId] : [],
        ),
        this.resolveViewerMutedByParent(
          [row.parentId ?? messageId],
          userId,
        ),
      ])

    const formatted = await this.formatMessageRow(
      row,
      reactionsByMessage,
      attachmentsMap,
      viewerMutedMap,
    )
    return { ...formatted, recipientIds }
  }

  /**
   * Finalize attachment: client upload xong file lên S3/Cloudinary,
   * gọi API này để update URL thật cho attachment row đang pending.
   *
   * Match attachment theo (messageId, pendingUploadId) — pendingUploadId là client-generated
   * uploadId, giúp client track progress/retry/finalize mà không cần biết server-generated id.
   *
   * Authorization: chỉ owner message được finalize.
   */
  async finalizeAttachment(
    messageId: string,
    pendingUploadId: string,
    userId: string,
    dto: FinalizeAttachmentDto,
  ) {
    if (!pendingUploadId || typeof pendingUploadId !== 'string') {
      throw new BadRequestException('pendingUploadId không hợp lệ')
    }

    const [message] = await this.db
      .select({
        id: messages.id,
        userId: messages.userId,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)

    if (!message || message.deletedAt) {
      throw new NotFoundException('Message không tồn tại')
    }
    if (message.userId !== userId) {
      throw new ForbiddenException(
        'Bạn không có quyền finalize attachment của message này',
      )
    }

    const [attachment] = await this.db
      .select({
        id: attachments.id,
        fileCategory: attachments.fileCategory,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.messageId, messageId),
          eq(attachments.pendingUploadId, pendingUploadId),
        ),
      )
      .limit(1)

    if (!attachment) {
      throw new NotFoundException(
        'Attachment không tồn tại hoặc đã được finalize',
      )
    }

    // Lấy workspaceId từ message để dùng cho thumbnail generation
    const [messageWithWorkspace] = await this.db
      .select({ workspaceId: messages.workspaceId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)

    const [updated] = await this.db
      .update(attachments)
      .set({
        url: dto.url,
        mimeType: dto.mimeType ?? null,
        width: dto.width ?? null,
        height: dto.height ?? null,
        duration: dto.duration ?? null,
        fileCategory: dto.fileCategory ?? attachment.fileCategory,
        pendingUploadId: null, // Clear sau khi finalize
        updatedAt: new Date(),
      })
      .where(eq(attachments.id, attachment.id))
      .returning()

    // Generate thumbnail cho Office files và lưu vào DB
    let previewImageUrl: string | null = null
    let previewStatus: 'ready' | 'failed' | null = null
    let previewErrorCode: string | null = null

    if (
      messageWithWorkspace?.workspaceId &&
      supportsOfficeThumbnail(updated.fileCategory)
    ) {
      try {
        const preview = await this.officeThumbnailGenerator.generateThumbnail({
          id: updated.id,
          workspaceId: messageWithWorkspace.workspaceId,
          name: updated.name,
          url: dto.url,
        })
        previewImageUrl = preview.previewImageUrl
        previewStatus = 'ready'

        // Update DB với preview data
        await this.db
          .update(attachments)
          .set({
            previewImageUrl,
            previewStatus,
            previewUpdatedAt: new Date(),
          })
          .where(eq(attachments.id, updated.id))
      } catch (error) {
        const previewError =
          error instanceof OfficeThumbnailError
            ? error
            : new OfficeThumbnailError(
                'unknown_preview_error',
                'Unknown Office preview generation error.',
              )
        this.logger.warn(
          `Office preview async failed for ${updated.name}: ${previewError.code}`,
        )
        previewStatus = 'failed'
        previewErrorCode = previewError.code

        // Update DB với error status
        await this.db
          .update(attachments)
          .set({
            previewStatus,
            previewErrorCode,
            previewUpdatedAt: new Date(),
          })
          .where(eq(attachments.id, updated.id))
      }
    }

    // Invalidate message cache (nếu có) để lần GET tiếp theo trả về attachment mới.
    await this.invalidateMessagePage1CachesForMessage(updated.messageId)

    // Lấy message đầy đủ để check còn attachment nào đang pendingUpload không.
    // Nếu tất cả file đã finalize xong → broadcast CREATE message đầy đủ cho User B.
    const fullMessage = await this.getMessageById(
      updated.messageId,
      userId,
    )
    const stillPending = Array.isArray(fullMessage?.attachments)
      && fullMessage.attachments.some(
        // FIX: check pendingUpload (computed boolean from pendingUploadId)
        (a: any) => a?.pendingUpload === true,
      )

    // DEBUG: Log URL in fullMessage.attachments
    this.logger.debug(
      `finalizeAttachment result - messageId: ${updated.messageId}, ` +
      `attachments count: ${fullMessage?.attachments?.length ?? 'N/A'}, ` +
      `URL length: ${fullMessage?.attachments?.[0]?.url?.length ?? 'N/A'}, ` +
      `URL: ${fullMessage?.attachments?.[0]?.url ?? 'N/A'}, ` +
      `stillPending: ${stillPending}`,
    )

    // Query lại attachment từ DB để lấy preview data mới nhất
    const [finalAttachment] = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, updated.id))
      .limit(1)

    return {
      attachment: this.enrichAttachmentWithSignedUrl(finalAttachment ?? updated),
      fullMessage,
      stillPending,
    }
  }

  /**
   * Enqueue deferred notification sau khi finalizeAttachment hoàn tất.
   * Gọi từ controller sau khi service trả về result.
   * Tách riêng để tránh circular dependency với NotificationModule.
   */
  async enqueueDeferredNotification(messageId: string, userId: string): Promise<void> {
    try {
      const message = await this.getMessageById(messageId, userId)
      if (!message) {
        this.logger.warn(`enqueueDeferredNotification: message ${messageId} not found`)
        return
      }

      const ctx = await this.getMessageBroadcastContext(messageId)
      if (!ctx) {
        this.logger.warn(`enqueueDeferredNotification: no broadcast context for ${messageId}`)
        return
      }

      await this.notificationService.enqueueNotificationJob({
        messageId,
        senderId: userId,
        workspaceId: ctx.workspaceId,
        channelId: message.channelId ?? undefined,
        conversationId: message.conversationId ?? undefined,
        content: message.content ?? '',
        parentId: message.parentId ?? null,
      })
      this.logger.log(
        `Enqueued deferred notification for finalized message ${messageId}`,
      )
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue deferred notification for ${messageId}: ${(err as Error).message}`,
      )
    }
  }

  /**
   * getParentThreadMetadata — lấy reply metadata của parent message để inject vào
   * broadcast CREATE khi finalizeAttachment hoàn tất.
   * Trả về { replyCount, replyParticipantIds, lastReplyAt, content, deletedAt } hoặc null.
   */
  async getParentThreadMetadata(
    parentMessageId: string,
  ): Promise<{
    replyCount: number
    replyParticipantIds: string[]
    lastReplyAt: string | null
    content: string | null
    deletedAt: string | null
  } | null> {
    const [row] = await this.db
      .select({
        replyCount: messages.replyCount,
        lastReplyAt: messages.lastReplyAt,
        content: messages.content,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      .where(eq(messages.id, parentMessageId))
      .limit(1)

    if (!row) return null

    // Lấy danh sách distinct userIds của các replies (giới hạn 5, giống createMessage)
    const participants = await this.db
      .select({ userId: messages.userId })
      .from(messages)
      .where(eq(messages.parentId, parentMessageId))
      .groupBy(messages.userId)
      .limit(5)

    const replyParticipantIds = participants.map((p) => p.userId)

    return {
      replyCount: row.replyCount ?? 0,
      replyParticipantIds,
      lastReplyAt:
        row.lastReplyAt instanceof Date
          ? row.lastReplyAt.toISOString()
          : (row.lastReplyAt as string | null),
      content:
        row.deletedAt !== null
          ? ''
          : (row.content as string | null),
      deletedAt:
        row.deletedAt instanceof Date
          ? row.deletedAt.toISOString()
          : (row.deletedAt as string | null),
    }
  }

  /**
   * Helper: invalidate cache cho message cụ thể.
   * Best-effort, swallow errors.
   */
  private async invalidateMessagePage1CachesForMessage(messageId: string) {
    try {
      const [msg] = await this.db
        .select({
          channelId: messages.channelId,
          conversationId: messages.conversationId,
        })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
      const targetIds: string[] = []
      if (msg?.channelId) targetIds.push(msg.channelId)
      if (msg?.conversationId) targetIds.push(msg.conversationId)
      if (targetIds.length > 0) {
        await this.invalidateMessagePage1Caches(targetIds)
      }
    } catch (err) {
      this.logger.warn(
        `invalidateMessagePage1CachesForMessage failed for ${messageId}: ${(err as Error).message}`,
      )
    }
  }

  /**
   * Helper: trả về room key + workspaceId cho message để broadcast event.
   * Channel messages → `channel:<id>`, DM → `conversation:<id>`, null nếu không tìm thấy.
   */
  async getMessageBroadcastContext(
    messageId: string,
  ): Promise<{ room: string; workspaceId: string } | null> {
    const [msg] = await this.db
      .select({
        channelId: messages.channelId,
        conversationId: messages.conversationId,
        workspaceId: sql<string>`COALESCE(${channels.workspaceId}, ${directMessageConversations.workspaceId})`,
      })
      .from(messages)
      .leftJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(
        directMessageConversations,
        eq(messages.conversationId, directMessageConversations.id),
      )
      .where(eq(messages.id, messageId))
      .limit(1)

    if (!msg) return null
    const room = msg.channelId
      ? `channel:${msg.channelId}`
      : msg.conversationId
        ? `conversation:${msg.conversationId}`
        : null
    if (!room || !msg.workspaceId) return null
    return { room, workspaceId: msg.workspaceId }
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
    const [{ reactionsByMessage, attachmentsMap }, viewerMutedMap] =
      await Promise.all([
        this.fetchMetadataForMessages(
          rows.map((r) => r.id),
          parentIds,
        ),
        this.resolveViewerMutedByParent(
          Array.from(new Set(rows.map((r) => r.parentId ?? r.id))),
          userId,
        ),
      ])

    // 4. Format all rows
    const formattedMessages = await this.formatMessagesAndResolveForwardSources(
      rows,
      reactionsByMessage,
      attachmentsMap,
      viewerMutedMap,
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
          // Soft delete: chỉ match rows CHƯA bị xoá
        ),
      )
      .where(eq(users.id, userId))
      .limit(1)

    if (!row) throw new NotFoundException('User not found')

    const isRemovedWorkspaceMember = row.wmId == null
    const name = isRemovedWorkspaceMember
      ? 'Deleted user'
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
        ? 'Deleted user'
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

  /**
   * abortMessage — HARD delete cho message có attachments đang pending upload.
   *
   * Chỉ cho phép khi:
   * 1. Message tồn tại + chưa bị xóa (deletedAt = null)
   * 2. Tất cả attachments còn pendingUploadId (chưa file nào finalize xong)
   * 3. Owner là user gọi
   *
   * → DELETE message row + CASCADE attachments
   * → Trả về room + parentId để controller broadcast message_deleted.
   *
   * Use case: user A upload file rồi navigate away/refresh — composer unmount
   * → cleanup API được gọi để xóa orphan message khỏi DB, tránh User B thấy spinner mãi.
   */
  async abortMessage(messageId: string, userId: string) {
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

    // Check message chưa bị soft-delete
    const [messageFresh] = await this.db
      .select({ deletedAt: messages.deletedAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    if (messageFresh?.deletedAt) {
      throw new ForbiddenException('Message already deleted')
    }

    // Check tất cả attachments của message này còn pendingUploadId
    // → nếu đã có 1 file finalize xong (url đã có) thì KHÔNG cho abort,
    //   user phải xóa cả message bằng deleteMessage thông thường.
    const allAttachments = await this.db
      .select({
        id: attachments.id,
        pendingUploadId: attachments.pendingUploadId,
        url: attachments.url,
      })
      .from(attachments)
      .where(eq(attachments.messageId, messageId))

    const hasFinalizedAttachment = allAttachments.some(
      (a) => !a.pendingUploadId || (a.url && a.url.length > 0),
    )
    if (hasFinalizedAttachment) {
      throw new ForbiddenException(
        'Message has finalized attachments — cannot abort',
      )
    }

    const targetId = (message.channelId || message.conversationId) as string
    const room = message.channelId
      ? `channel:${message.channelId}`
      : `conversation:${message.conversationId}`

    // Hard delete message — attachments CASCADE theo schema FK
    await this.db.delete(messages).where(eq(messages.id, messageId))

    // Invalidate cache
    await this.redis.del(this.messageCacheKey(targetId))

    this.logger.log(
      `Aborted pending-upload message ${messageId} (owner=${userId}, attachments=${allAttachments.length})`,
    )

    return { messageId, room, aborted: true, parentId: message.parentId }
  }

  /**
   * cleanupStalePendingAttachments — TTL cleanup cho attachment pending quá lâu.
   *
   * Use case: user A đã gọi sendMessage với attachments đang pending, nhưng bị mất kết nối /
   * refresh / kill tab trước khi finalize (hoặc trước khi abort API được gọi).
   * → Attachment row treo vĩnh viễn → User B refresh sẽ thấy spinner vô tận.
   *
   * Giải pháp: method này tìm các attachments có `pendingUploadId IS NOT NULL`
   * + `url = ''` + `createdAt < cutoff` (mặc định 30 phút).
   * Với MỖI attachment tìm được:
   * - Nếu message có file khác đã finalize → KHÔNG abort (chỉ xoá file pending, giữ message)
   *   (nhưng thực tế trong hệ thống hiện tại, mỗi message abort phải all-or-nothing,
   *    nên ta sẽ abort toàn message nếu TẤT CẢ file pending)
   * - Nếu TẤT CẢ attachment của message vẫn pending → HARD delete message
   *
   * Trả về danh sách messageIds đã bị xoá để caller broadcast nếu cần.
   * Best-effort: swallow errors, log warning.
   */
  async cleanupStalePendingAttachments(
    staleAfterMinutes = 30,
  ): Promise<string[]> {
    try {
      const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000)

      // Tìm attachments pending quá cũ
      const staleAttachments = await this.db
        .select({
          messageId: attachments.messageId,
          attachmentId: attachments.id,
          pendingUploadId: attachments.pendingUploadId,
        })
        .from(attachments)
        .where(
          and(
            isNotNull(attachments.pendingUploadId),
            or(eq(attachments.url, ''), isNull(attachments.url)),
            lt(attachments.createdAt, cutoff),
          ),
        )

      if (staleAttachments.length === 0) return []

      // Group theo messageId
      const messageIds = Array.from(
        new Set(staleAttachments.map((a) => a.messageId)),
      )

      // Với mỗi message, check xem còn attachment nào đã finalize không
      const messagesToAbort: string[] = []
      for (const messageId of messageIds) {
        const allAtts = await this.db
          .select({
            id: attachments.id,
            pendingUploadId: attachments.pendingUploadId,
            url: attachments.url,
          })
          .from(attachments)
          .where(eq(attachments.messageId, messageId))

        const hasFinalizedAttachment = allAtts.some(
          (a) => !a.pendingUploadId || (a.url && a.url.length > 0),
        )
        if (!hasFinalizedAttachment) {
          messagesToAbort.push(messageId)
        }
      }

      // Hard delete các orphan messages
      for (const messageId of messagesToAbort) {
        await this.db.delete(messages).where(eq(messages.id, messageId))
        this.logger.log(
          `TTL cleanup: aborted stale pending-upload message ${messageId}`,
        )
      }

      // Invalidate cache cho các message bị xoá
      if (messagesToAbort.length > 0) {
        const targetIds = await this.db
          .select({
            channelId: messages.channelId,
            conversationId: messages.conversationId,
          })
          .from(messages)
          .where(inArray(messages.id, messagesToAbort))
        const targetIdSet = new Set<string>()
        for (const t of targetIds) {
          if (t.channelId) targetIdSet.add(t.channelId)
          if (t.conversationId) targetIdSet.add(t.conversationId)
        }
        await this.invalidateMessagePage1Caches(Array.from(targetIdSet))
      }

      return messagesToAbort
    } catch (err) {
      this.logger.warn(
        `cleanupStalePendingAttachments failed: ${(err as Error).message}`,
      )
      return []
    }
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

    const viewerMutedMap = await this.resolveViewerMutedByParent(
      Array.from(new Set(rows.map((r) => r.parentId ?? r.id))),
      userId,
    )

    const formattedMessages = await this.formatMessagesAndResolveForwardSources(
      rows,
      reactionsByMessage,
      attachmentsMap,
      viewerMutedMap,
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

    const viewerMutedMap = await this.resolveViewerMutedByParent(
      Array.from(new Set(pageRows.map((r) => r.parentId ?? r.id))),
      userId,
    )

    const formattedMessages = await this.formatMessagesAndResolveForwardSources(
      pageRows,
      reactionsByMessage,
      attachmentsMap,
      viewerMutedMap,
    )

    // Map formatted → items (giữ shape cũ với rank/excerpt/location)
    const items = formattedMessages.map((message, idx) => {
      const row = pageRows[idx]
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
    })

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
          pendingUpload: false,
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
            membershipStatus: row.userMembershipStatus ?? 'active',
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
        userName: maskedAuthorNameExpr,
        userAvatar: maskedAuthorAvatarExpr,
        userDisplayName: maskedAuthorDisplayNameExpr,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userStatus: workspaceMembers.statusText,
        userStatusEmoji: workspaceMembers.statusEmoji,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userPhone: workspaceMembers.phone,
        userDescription: workspaceMembers.description,
        userTimeZone: workspaceMembers.timeZone,
        userMembershipStatus: maskedAuthorStatusExpr,
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
   * markThreadAsUnread — Cập nhật lastReadAt cho một thread cụ thể của user
   * bằng createdAt của message được chỉ định.
   */
  async markThreadAsUnread(parentMessageId: string, messageId: string, userId: string) {
    // Get the message's createdAt to set as lastReadAt
    const [message] = await this.db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)

    if (!message) {
      throw new NotFoundException('Message not found')
    }

    await this.db
      .update(threadSubscriptions)
      .set({ lastReadAt: message.createdAt })
      .where(
        and(
          eq(threadSubscriptions.userId, userId),
          eq(threadSubscriptions.parentMessageId, parentMessageId),
        ),
      )
  }

  /**
   * toggleThreadMute — Bật/tắt thông báo cho một thread cụ thể của user.
   * Nếu chưa có subscription thì tạo mới (ensure).
   */
  async toggleThreadMute(
    userId: string,
    parentMessageId: string,
    workspaceId: string,
    isMuted: boolean,
  ) {
    await this.ensureThreadSubscription(userId, parentMessageId, workspaceId)

    const [parent] = await this.db
      .select({
        channelId: messages.channelId,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(eq(messages.id, parentMessageId))
      .limit(1)

    const [updated] = await this.db
      .update(threadSubscriptions)
      .set({ isMuted })
      .where(
        and(
          eq(threadSubscriptions.userId, userId),
          eq(threadSubscriptions.parentMessageId, parentMessageId),
        ),
      )
      .returning()

    // Invalidate page-1 cache để lần fetch sau trả viewerIsMuted mới.
    if (parent?.channelId) {
      await this.redis.del(this.messageCacheKey(parent.channelId))
    } else if (parent?.conversationId) {
      await this.redis.del(this.messageCacheKey(parent.conversationId))
    }

    return updated ?? { isMuted }
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
        userName: maskedAuthorNameExpr,
        userAvatar: maskedAuthorAvatarExpr,
        userDisplayName: maskedAuthorDisplayNameExpr,
        userIsAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        userStatus: workspaceMembers.statusText,
        userStatusEmoji: workspaceMembers.statusEmoji,
        userNamePronunciation: workspaceMembers.namePronunciation,
        userPhone: workspaceMembers.phone,
        userDescription: workspaceMembers.description,
        userTimeZone: workspaceMembers.timeZone,
        userMembershipStatus: maskedAuthorStatusExpr,
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
        isMuted: threadSubscriptions.isMuted,
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
      isMuted: boolean
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

    // Tất cả rows ở đây đều là parent messages (threadSubscriptions.parentMessageId)
    // nên mỗi row có isMuted trực tiếp từ join — build map để formatMessageRow dùng.
    const viewerMutedMap = new Map<string, boolean>()
    threadRows.forEach((r) => viewerMutedMap.set(r.id, r.isMuted))

    // 3. Format kết quả trả về
    const threads = await Promise.all(
      threadRows.map(async (row) => {
        const formatted = await this.formatMessageRow(
          row,
          reactionsByMessage,
          attachmentsMap,
          viewerMutedMap,
        )
        // Resolve forward source nếu có (per-thread batch)
        if (formatted.forwardSnapshot) {
          await this.resolveForwardedSourceUsers([formatted])
        }

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

