import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DRIZZLE } from '../database/database.module'
import * as schema from '../database/schema'
import { attachments } from '../database/schema'
import { S3Service } from '../upload/s3.service'
import type { CreateAttachmentDto } from './dto/create-attachment.dto'

/**
 * AttachmentService — Business logic cho file attachments
 *
 * Responsibilities:
 * - Lưu metadata của file đã upload vào DB
 * - Query attachments theo messageId
 * - Delete attachment (+ xóa file trên S3/Cloudinary nếu cần)
 */
@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name)

  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * Tạo attachment record sau khi file đã upload lên S3/Cloudinary
   */
  async createAttachment(dto: CreateAttachmentDto) {
    const [attachment] = (await this.db
      .insert(attachments)
      .values({
        messageId: dto.messageId,
        url: dto.url,
        type: dto.type,
        name: dto.name,
        size: dto.size,
        mimeType: dto.mimeType ?? null,
        width: dto.width ?? null,
        height: dto.height ?? null,
        duration: dto.duration ?? null,
      })
      .returning()) as Array<{
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

    this.logger.log(
      `Created attachment: ${attachment.id} for message ${dto.messageId}`,
    )

    // Trả presigned URL cho S3 (bucket private), truyền name để download đúng tên tiếng Việt
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
        // Fallback: trả URL gốc
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

    // Group by messageId
    const map = new Map<string, typeof results>()
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
        userId: schema.messages.userId,
      })
      .from(attachments)
      .innerJoin(schema.messages, eq(schema.messages.id, attachments.messageId))
      .where(eq(attachments.id, attachmentId))
      .limit(1)) as Array<{
      id: string
      messageId: string
      userId: string
    }>

    if (!attachment) {
      throw new NotFoundException('Attachment not found')
    }

    if (attachment.userId !== userId) {
      throw new NotFoundException('Unauthorized')
    }

    // Hard delete (hoặc có thể soft delete nếu cần)
    await this.db.delete(attachments).where(eq(attachments.id, attachmentId))

    this.logger.log(`Deleted attachment: ${attachmentId}`)

    return { success: true }
  }
}
