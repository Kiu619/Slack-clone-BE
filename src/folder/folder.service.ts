import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  attachments,
  channelFolders,
  channelMembers,
  channels,
  folderAttachments,
  messages,
  users,
  workspaceMembers,
} from '../database/schema'
import { S3Service } from '../upload/s3.service'
import { RedisService } from '../redis/redis.service'
import type { UploadFileToFolderDto } from './dto/folder.dto'

const FOLDER_ATTACHMENTS_PAGE_SIZE = 30

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

type FolderLinkRow = ChannelFileJoinRow & {
  linkId: string
  linkAddedAt: Date
}

@Injectable()
export class FolderService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly s3Service: S3Service,
    private readonly redis: RedisService,
  ) {}

  /** Đồng bộ với MessageService.messageCacheKey */
  private messageCacheKey(channelId: string): string {
    return `messages:v2:${channelId}:page1`
  }

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

    return row
  }

  private parseFolderLinkCursor(
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

  private async assertFolderInChannel(
    folderId: string,
    channelId: string,
  ): Promise<{ id: string; name: string }> {
    const [f] = await this.db
      .select({ id: channelFolders.id, name: channelFolders.name })
      .from(channelFolders)
      .where(
        and(
          eq(channelFolders.id, folderId),
          eq(channelFolders.channelId, channelId),
        ),
      )
      .limit(1)
    if (!f) throw new NotFoundException('Folder not found')
    return f
  }

  async listFolders(channelId: string, userId: string) {
    await this.assertChannelAccess(channelId, userId)
    const rows = await this.db
      .select({
        id: channelFolders.id,
        channelId: channelFolders.channelId,
        name: channelFolders.name,
        createdAt: channelFolders.createdAt,
        updatedAt: channelFolders.updatedAt,
      })
      .from(channelFolders)
      .where(eq(channelFolders.channelId, channelId))
      .orderBy(desc(channelFolders.createdAt))

    return {
      folders: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    }
  }

  async createFolder(channelId: string, userId: string, name: string) {
    await this.assertChannelAccess(channelId, userId)
    const trimmed = name.trim()
    try {
      const [row] = await this.db
        .insert(channelFolders)
        .values({
          id: randomUUID(),
          channelId,
          name: trimmed,
          createdById: userId,
        })
        .returning()
      if (!row) throw new ConflictException('Could not create folder')
      return {
        folder: {
          id: row.id,
          channelId: row.channelId,
          name: row.name,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      }
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code
      if (code === '23505') {
        throw new ConflictException('A folder with this name already exists')
      }
      throw e
    }
  }

  async renameFolder(
    channelId: string,
    folderId: string,
    userId: string,
    name: string,
  ) {
    await this.assertChannelAccess(channelId, userId)
    await this.assertFolderInChannel(folderId, channelId)
    const trimmed = name.trim()
    try {
      const [row] = await this.db
        .update(channelFolders)
        .set({ name: trimmed, updatedAt: new Date() })
        .where(eq(channelFolders.id, folderId))
        .returning()
      if (!row) throw new NotFoundException('Folder not found')
      return {
        folder: {
          id: row.id,
          channelId: row.channelId,
          name: row.name,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      }
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code
      if (code === '23505') {
        throw new ConflictException('A folder with this name already exists')
      }
      throw e
    }
  }

  async deleteFolder(channelId: string, folderId: string, userId: string) {
    await this.assertChannelAccess(channelId, userId)
    await this.assertFolderInChannel(folderId, channelId)
    await this.db.delete(channelFolders).where(eq(channelFolders.id, folderId))
    return { deleted: true, folderId }
  }

  async listFolderAttachments(
    channelId: string,
    folderId: string,
    userId: string,
    cursor?: string,
    limit = FOLDER_ATTACHMENTS_PAGE_SIZE,
  ) {
    await this.assertChannelAccess(channelId, userId)
    await this.assertFolderInChannel(folderId, channelId)

    const parsed = this.parseFolderLinkCursor(cursor)
    const cursorCond = parsed
      ? or(
          lt(folderAttachments.addedAt, parsed.at),
          and(
            eq(folderAttachments.addedAt, parsed.at),
            lt(folderAttachments.id, parsed.id),
          ),
        )
      : undefined

    const baseWhere = and(
      eq(folderAttachments.folderId, folderId),
      eq(messages.channelId, channelId),
      isNull(messages.deletedAt),
    )

    const whereExpr = cursorCond ? and(baseWhere, cursorCond) : baseWhere

    const rows = (await this.db
      .select({
        linkId: folderAttachments.id,
        linkAddedAt: folderAttachments.addedAt,
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
      .from(folderAttachments)
      .innerJoin(
        attachments,
        eq(folderAttachments.attachmentId, attachments.id),
      )
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
      .orderBy(desc(folderAttachments.addedAt), desc(folderAttachments.id))
      .limit(limit + 1)) as FolderLinkRow[]

    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const fileRows: ChannelFileJoinRow[] = pageRows.map(
      ({ linkId: _l, linkAddedAt: _a, ...rest }) => rest,
    )
    const results = await this.mapChannelFileJoinRowsToHits(fileRows)

    const last = pageRows[pageRows.length - 1]
    const nextCursor =
      hasMore && last
        ? `${last.linkAddedAt.toISOString()}__${last.linkId}`
        : null

    return { results, nextCursor, hasMore }
  }

  async addAttachmentToFolder(
    channelId: string,
    folderId: string,
    userId: string,
    attachmentId: string,
  ) {
    await this.assertChannelAccess(channelId, userId)
    await this.assertFolderInChannel(folderId, channelId)

    const [attRow] = await this.db
      .select({
        id: attachments.id,
        messageId: attachments.messageId,
        channelId: messages.channelId,
        deletedAt: messages.deletedAt,
      })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .where(eq(attachments.id, attachmentId))
      .limit(1)

    if (!attRow) throw new NotFoundException('Attachment not found')
    if (attRow.channelId !== channelId)
      throw new ForbiddenException('Attachment is not in this channel')
    if (attRow.deletedAt)
      throw new ForbiddenException('Cannot add attachment from deleted message')

    try {
      await this.db.insert(folderAttachments).values({
        id: randomUUID(),
        folderId,
        attachmentId,
        addedById: userId,
      })
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code
      if (code === '23505') {
        throw new ConflictException('This file is already in the folder')
      }
      throw e
    }

    return { ok: true, folderId, attachmentId }
  }

  async removeAttachmentFromFolder(
    channelId: string,
    folderId: string,
    userId: string,
    attachmentId: string,
  ) {
    await this.assertChannelAccess(channelId, userId)
    await this.assertFolderInChannel(folderId, channelId)

    const res = await this.db
      .delete(folderAttachments)
      .where(
        and(
          eq(folderAttachments.folderId, folderId),
          eq(folderAttachments.attachmentId, attachmentId),
        ),
      )
      .returning({ id: folderAttachments.id })

    if (!res.length) throw new NotFoundException('Attachment not in folder')

    return { ok: true, folderId, attachmentId }
  }

  /**
   * Client đã upload binary lên S3/Cloudinary — lưu DB và gắn vào folder.
   * Tạo message `system` + content `<p></p>` để gắn attachment (message_id NOT NULL);
   * client ẩn `type === 'system'` khỏi timeline chat.
   */
  async uploadFileToFolder(
    channelId: string,
    folderId: string,
    userId: string,
    dto: UploadFileToFolderDto,
  ) {
    await this.assertChannelAccess(channelId, userId)
    await this.assertFolderInChannel(folderId, channelId)

    const { msg, att } = await this.db.transaction(async (tx) => {
      const [m] = (await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          channelId,
          userId,
          content: '<p></p>',
          /** Không hiển thị trong timeline chat — client lọc `type === 'system'` */
          type: 'system',
          parentId: null,
        })
        .returning()) as Array<{ id: string }>

      const [a] = (await tx
        .insert(attachments)
        .values({
          id: randomUUID(),
          messageId: m.id,
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

      await tx.insert(folderAttachments).values({
        id: randomUUID(),
        folderId,
        attachmentId: a.id,
        addedById: userId,
      })

      return { msg: m, att: a }
    })

    await this.redis.del(this.messageCacheKey(channelId))

    const enriched = await this.enrichAttachmentWithSignedUrl({
      ...att,
      name: att.name,
    })
    const createdAt =
      enriched.createdAt instanceof Date
        ? enriched.createdAt.toISOString()
        : String(enriched.createdAt)

    return {
      messageId: msg.id,
      attachment: {
        ...enriched,
        createdAt,
      },
    }
  }
}
