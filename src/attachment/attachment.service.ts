import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { and, desc, eq, exists, inArray, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DRIZZLE } from '../database/database.module'
import * as schema from '../database/schema'
import { attachments, userFileInteractions } from '../database/schema'
import { LaterService } from '../later/later.service'
import { CloudinaryService } from '../upload/cloudinary.service'
import { S3Service } from '../upload/s3.service'
import { WorkspacePermissionsService } from '../workspace/workspace-permissions.service'
import type {
  CreateAttachmentDto,
  SearchAttachmentsDto,
} from './dto/create-attachment.dto'

/**
 * AttachmentService — Business logic cho file attachments
 */
@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name)

  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
    private readonly s3Service: S3Service,
    private readonly cloudinaryService: CloudinaryService,
    private readonly laterService: LaterService,
    private readonly permissionsService: WorkspacePermissionsService,
  ) {}

  /**
   * Tạo attachment record sau khi file đã upload lên S3/Cloudinary
   */
  async createAttachment(dto: CreateAttachmentDto, userId: string) {
    const fileCategory =
      dto.fileCategory || this.getFileCategory(dto.mimeType, dto.name)

    const [attachment] = (await this.db
      .insert(attachments)
      .values({
        messageId: dto.messageId,
        workspaceId: dto.workspaceId,
        userId: userId,
        channelId: dto.channelId ?? null,
        conversationId: dto.conversationId ?? null,
        fileCategory,
        url: dto.url,
        type: dto.type,
        name: dto.name,
        size: dto.size,
        mimeType: dto.mimeType ?? null,
        width: dto.width ?? null,
        height: dto.height ?? null,
        duration: dto.duration ?? null,
        previewImageUrl: null,
        previewStatus: null,
        previewUpdatedAt: null,
        previewErrorCode: null,
        originScope: 'message_body',
      })
      .returning()) as any[]

    this.logger.log(
      `Created attachment: ${attachment.id} for message ${dto.messageId}`,
    )

    return this.enrichAttachmentWithUrl(attachment)
  }

  /**
   * Search attachments với đầy đủ bộ lọc (All Files)
   */
  async searchAttachments(dto: SearchAttachmentsDto, currentUserId: string) {
    const {
      workspaceId,
      scope,
      categories,
      sort,
      userIds,
      channelIds,
      conversationIds,
      dateFrom,
      dateTo,
      limit,
      offset,
    } = dto

    const conditions = [eq(attachments.workspaceId, workspaceId)]

    // 1. Security: Chỉ xem file trong channel/DM mà user tham gia
    // Hoặc file đó do chính user upload
    const securityCondition = or(
      eq(attachments.userId, currentUserId),
      // Channel Public (giả định channelId isNotNull và không private)
      exists(
        this.db
          .select()
          .from(schema.channels)
          .where(
            and(
              eq(schema.channels.id, attachments.channelId),
              eq(schema.channels.isPrivate, false),
            ),
          ),
      ),
      // Channel Private mà user tham gia
      exists(
        this.db
          .select()
          .from(schema.channelMembers)
          .where(
            and(
              eq(schema.channelMembers.channelId, attachments.channelId),
              eq(schema.channelMembers.userId, currentUserId),
            ),
          ),
      ),
      // DM mà user tham gia
      exists(
        this.db
          .select()
          .from(schema.conversationMembers)
          .where(
            and(
              eq(
                schema.conversationMembers.conversationId,
                attachments.conversationId,
              ),
              eq(schema.conversationMembers.userId, currentUserId),
            ),
          ),
      ),
    )
    if (securityCondition) conditions.push(securityCondition)

    // 2. Scope: Created by me / Shared with me
    if (scope === 'created_by_me') {
      conditions.push(eq(attachments.userId, currentUserId))
    } else if (scope === 'shared_with_me') {
      conditions.push(sql`${attachments.userId} != ${currentUserId}`)
    }

    // 3. Categories
    if (categories) {
      const catList = categories.split(',')
      conditions.push(inArray(attachments.fileCategory, catList))
    }

    // 4. From (UserIds)
    if (userIds) {
      conditions.push(inArray(attachments.userId, userIds.split(',')))
    }

    // 5. In (ChannelIds / ConversationIds)
    if (channelIds || conversationIds) {
      const inConditions: SQL[] = []
      if (channelIds)
        inConditions.push(inArray(attachments.channelId, channelIds.split(',')))
      if (conversationIds)
        inConditions.push(
          inArray(attachments.conversationId, conversationIds.split(',')),
        )
      if (inConditions.length > 0) {
        conditions.push(or(...inConditions)!)
      }
    }

    // 6. Date
    if (dateFrom) {
      conditions.push(sql`${attachments.createdAt} >= ${dateFrom}`)
    }
    if (dateTo) {
      conditions.push(sql`${attachments.createdAt} <= ${dateTo}`)
    }

    // 7. Name search (Search by file name)
    if (dto.name) {
      conditions.push(sql`${attachments.name} ILIKE ${'%' + dto.name + '%'}`)
    }

    // 8. Sort & Query
    const query = this.db
      .select({
        attachment: attachments,
        message: schema.messages,
        member: schema.workspaceMembers,
      })
      .from(attachments)
      .innerJoin(schema.messages, eq(attachments.messageId, schema.messages.id))
      .innerJoin(
        schema.workspaceMembers,
        and(
          eq(schema.messages.userId, schema.workspaceMembers.userId),
          eq(schema.messages.workspaceId, schema.workspaceMembers.workspaceId),
        ),
      )
      .where(and(...conditions))

    if (sort === 'recent_viewed') {
      // Join với bảng interactions - Dùng innerJoin để CHỈ lấy những file đã xem
      const results = await this.db
        .select({
          attachment: attachments,
          message: schema.messages,
          member: schema.workspaceMembers,
          lastViewedAt: userFileInteractions.lastViewedAt,
        })
        .from(attachments)
        .innerJoin(
          schema.messages,
          eq(attachments.messageId, schema.messages.id),
        )
        .innerJoin(
          schema.workspaceMembers,
          and(
            eq(schema.messages.userId, schema.workspaceMembers.userId),
            eq(
              schema.messages.workspaceId,
              schema.workspaceMembers.workspaceId,
            ),
          ),
        )
        .innerJoin(
          userFileInteractions,
          and(
            eq(userFileInteractions.attachmentId, attachments.id),
            eq(userFileInteractions.userId, currentUserId),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(userFileInteractions.lastViewedAt))
        .limit(limit)
        .offset(offset)

      return Promise.all(
        results.map(async (r) => ({
          attachment: await this.enrichAttachmentWithUrl(r.attachment),
          message: {
            ...r.message,
            user: r.member as any, // Đã có email trong member
            reactions: [], // TODO: Load reactions if needed
            attachments: [],
          },
        })),
      )
    }

    const orderBy =
      sort === 'last_updated'
        ? desc(attachments.updatedAt)
        : desc(attachments.createdAt)

    const results = await query.orderBy(orderBy).limit(limit).offset(offset)
    return Promise.all(
      results.map(async (r) => ({
        attachment: await this.enrichAttachmentWithUrl(r.attachment),
        message: {
          ...r.message,
          user: r.member as any, // Đã có email trong member
          reactions: [],
          attachments: [],
        },
      })),
    )
  }

  /**
   * Đánh dấu user vừa xem file
   */
  async trackView(attachmentId: string, userId: string, workspaceId: string) {
    // Verify workspace membership
    const membership = await this.permissionsService.getWorkspaceMembership(
      workspaceId,
      userId,
    )
    if (!membership) {
      throw new NotFoundException('You are not a member of this workspace')
    }

    await this.db
      .insert(userFileInteractions)
      .values({
        attachmentId,
        userId,
        workspaceId,
        lastViewedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          userFileInteractions.userId,
          userFileInteractions.attachmentId,
        ],
        set: { lastViewedAt: new Date() },
      })
    return { success: true }
  }

  /**
   * Helper: Phân loại file category dựa trên mimeType hoặc name
   */
  private getFileCategory(mimeType?: string | null, name?: string): string {
    const ext = name?.split('.').pop()?.toLowerCase()

    // 1. Ưu tiên check theo đuôi file (Extension) - Chính xác nhất cho các loại file phổ biến
    if (ext) {
      if (['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return 'spreadsheet'
      if (['pptx', 'ppt', 'odp'].includes(ext)) return 'presentation'
      if (['pdf'].includes(ext)) return 'pdf'
      if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext)) return 'document'
      if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive'
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext))
        return 'image'
      if (['mp4', 'mov', 'wmv', 'avi', 'webm', 'mkv'].includes(ext)) {
        // Nếu là .webm, cần check thêm mimeType vì nó có thể là audio
        if (ext === 'webm' && mimeType?.includes('audio')) return 'audio'
        return 'video'
      }
      if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext))
        return 'audio'
      if (
        [
          'js',
          'ts',
          'tsx',
          'jsx',
          'py',
          'java',
          'c',
          'cpp',
          'cs',
          'html',
          'css',
          'json',
          'md',
          'php',
          'sh',
          'sql',
        ].includes(ext)
      )
        return 'code'
    }

    // 2. Fallback check theo mimeType nếu không có extension hoặc extension lạ
    if (!mimeType) return 'other'

    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType.startsWith('video/')) return 'video'
    if (mimeType.startsWith('audio/') || mimeType.includes('audio'))
      return 'audio'
    if (mimeType === 'application/pdf' || mimeType.includes('pdf')) return 'pdf'
    if (
      mimeType.includes('spreadsheet') ||
      mimeType.includes('excel') ||
      mimeType.includes('sheet') ||
      mimeType.includes('csv')
    )
      return 'spreadsheet'
    if (
      mimeType.includes('presentation') ||
      mimeType.includes('powerpoint') ||
      mimeType.includes('officedocument.presentationml')
    )
      return 'presentation'
    if (
      mimeType.includes('word') ||
      mimeType.includes('officedocument.wordprocessingml') ||
      mimeType === 'application/msword' ||
      mimeType.includes('document') ||
      mimeType.includes('wordprocessingml')
    )
      return 'document'
    if (
      mimeType.includes('zip') ||
      mimeType.includes('rar') ||
      mimeType.includes('tar') ||
      mimeType.includes('compressed') ||
      mimeType.includes('archive')
    )
      return 'archive'
    if (
      mimeType.includes('javascript') ||
      mimeType.includes('typescript') ||
      mimeType.includes('json') ||
      mimeType.includes('html') ||
      mimeType.includes('text/') ||
      mimeType === 'application/x-httpd-php' ||
      mimeType.includes('code')
    )
      return 'code'

    return 'other'
  }

  /**
   * Helper: Thêm presigned URL nếu là S3
   */
  private async enrichAttachmentWithUrl(attachment: any) {
    const key = this.s3Service.parseS3KeyFromUrl(attachment.url)
    if (key) {
      try {
        const signedUrl = await this.s3Service.getPresignedGetUrl(
          key,
          86400,
          attachment.name,
        )
        return { ...attachment, url: signedUrl }
      } catch {
        // Fallback
      }
    }
    return attachment
  }

  /**
   * Lấy tất cả attachments của một message
   */
  async getAttachmentsByMessageId(messageId: string) {
    const results = (await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, messageId))
      .orderBy(attachments.createdAt)) as Array<{
      id: string
      messageId: string
      url: string
      type: string
      name: string
      size: number
      mimeType: string | null
      width: number | null
      height: number | null
      duration: number | null
      createdAt: Date
    }>

    return results
  }

  /**
   * Lấy tất cả attachments cho nhiều messages (dùng trong getMessages)
   * Returns Map<messageId, Attachment[]>
   */
  async getAttachmentsByMessageIds(
    messageIds: string[],
  ): Promise<Map<string, Array<typeof attachments.$inferSelect>>> {
    if (!messageIds.length) return new Map()

    const results = (await this.db
      .select()
      .from(attachments)
      .where(inArray(attachments.messageId, messageIds))
      .orderBy(attachments.createdAt)) as Array<typeof attachments.$inferSelect>

    // Group by messageId
    const map = new Map<string, Array<typeof attachments.$inferSelect>>()
    for (const att of results) {
      const list = map.get(att.messageId) ?? []
      list.push(att)
      map.set(att.messageId, list)
    }

    return map
  }

  /**
   * Xóa attachment (khi user xóa file)
   * TODO: Thêm logic xóa file thật trên S3/Cloudinary
   */
  async deleteAttachment(attachmentId: string, userId: string) {
    // Kiểm tra quyền: chỉ owner của message mới được xóa attachment
    const [attachment] = (await this.db
      .select({
        id: attachments.id,
        messageId: attachments.messageId,
        workspaceId: attachments.workspaceId,
        url: attachments.url,
        userId: schema.messages.userId,
        channelId: schema.messages.channelId,
        conversationId: schema.messages.conversationId,
      })
      .from(attachments)
      .innerJoin(schema.messages, eq(schema.messages.id, attachments.messageId))
      .where(eq(attachments.id, attachmentId))
      .limit(1)) as Array<{
      id: string
      messageId: string
      workspaceId: string
      url: string
      userId: string
      channelId: string | null
      conversationId: string | null
    }>

    if (!attachment) {
      throw new NotFoundException('Attachment not found')
    }

    if (attachment.userId !== userId) {
      throw new NotFoundException('Unauthorized')
    }

    await this.deleteAttachmentStorage({
      id: attachment.id,
      url: attachment.url,
    })

    // Hard delete (hoặc có thể soft delete nếu cần)
    await this.db.delete(attachments).where(eq(attachments.id, attachmentId))

    try {
      await this.laterService.purgeAllItemsForAttachment(
        attachment.workspaceId,
        attachmentId,
      )
    } catch (error) {
      this.logger.warn(
        `Attachment deleted but Later purge failed for ${attachmentId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.logger.log(`Deleted attachment: ${attachmentId}`)

    return {
      success: true,
      messageId: attachment.messageId,
      channelId: attachment.channelId,
      conversationId: attachment.conversationId,
      attachmentId,
    }
  }

  /**
   * Xóa blob vật lý theo URL attachment.
   * Nếu không xác định được storage target thì coi là lỗi để tránh xóa DB trước khi dọn file.
   */
  async deleteAttachmentStorage(attachment: {
    id: string
    url: string
    type?: string | null
  }) {
    const s3Key = this.s3Service.parseS3KeyFromUrl(attachment.url)
    if (s3Key) {
      await this.s3Service.deleteObject(s3Key)
      return { storage: 's3' as const, key: s3Key }
    }

    const cloudinaryTarget = this.cloudinaryService.extractDeleteTarget(
      attachment.url,
    )
    if (cloudinaryTarget) {
      const deleted = await this.cloudinaryService.deleteFile(
        cloudinaryTarget.publicId,
        cloudinaryTarget.resourceType,
      )
      return {
        storage: 'cloudinary' as const,
        publicId: cloudinaryTarget.publicId,
        resourceType: cloudinaryTarget.resourceType,
        deleted,
      }
    }

    const message = `Cannot resolve storage target for attachment ${attachment.id}`
    this.logger.error(`${message}: ${attachment.url}`)
    throw new InternalServerErrorException(
      'Không thể xóa file vì không xác định được nơi lưu trữ',
    )
  }

  async deleteAttachmentStorageBatch(
    attachmentsToDelete: Array<{
      id: string
      url: string
      type?: string | null
    }>,
  ) {
    for (const attachment of attachmentsToDelete) {
      await this.deleteAttachmentStorage(attachment)
    }
  }
}
