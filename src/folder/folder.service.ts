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
  directMessageConversations,
  conversationMembers,
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
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
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
  conversationId: string | null
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
    private readonly broadcastService: ChatBroadcastService,
  ) {}

  private folderChatRoom(target: {
    channelId?: string
    conversationId?: string
  }): string {
    if (target.channelId) return `channel:${target.channelId}`
    return `conversation:${target.conversationId!}`
  }

  /** Đồng bộ với MessageService.messageCacheKey */
  private messageCacheKey(targetId: string): string {
    return `messages:v2:${targetId}:page1`
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

  private async assertConversationAccess(
    conversationId: string,
    userId: string,
  ) {
    const [row] = await this.db
      .select({
        id: directMessageConversations.id,
        workspaceId: directMessageConversations.workspaceId,
        memberId: conversationMembers.id,
      })
      .from(directMessageConversations)
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, directMessageConversations.id),
          eq(conversationMembers.userId, userId),
        ),
      )
      .where(eq(directMessageConversations.id, conversationId))
      .limit(1)

    if (!row)
      throw new NotFoundException('Conversation not found or access denied')

    return row
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
    if (!row.chMemberId && row.isPrivate) throw new ForbiddenException('Not a channel member')

    return row
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

  private async mapFileJoinRowsToHits(rows: ChannelFileJoinRow[]) {
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

  private async assertFolderInTarget(
    folderId: string,
    target: { channelId?: string; conversationId?: string },
  ): Promise<{ id: string; name: string }> {
    const whereExpr = target.channelId
      ? and(
          eq(channelFolders.id, folderId),
          eq(channelFolders.channelId, target.channelId),
        )
      : and(
          eq(channelFolders.id, folderId),
          eq(channelFolders.conversationId, target.conversationId!),
        )

    const [f] = await this.db
      .select({ id: channelFolders.id, name: channelFolders.name })
      .from(channelFolders)
      .where(whereExpr)
      .limit(1)
    if (!f) throw new NotFoundException('Folder not found')
    return f
  }

  async listFolders(
    target: { channelId?: string; conversationId?: string },
    userId: string,
  ) {
    await this.assertTargetAccess(target, userId)
    const whereExpr = target.channelId
      ? eq(channelFolders.channelId, target.channelId)
      : eq(channelFolders.conversationId, target.conversationId!)

    const rows = await this.db
      .select({
        id: channelFolders.id,
        channelId: channelFolders.channelId,
        conversationId: channelFolders.conversationId,
        name: channelFolders.name,
        createdAt: channelFolders.createdAt,
        updatedAt: channelFolders.updatedAt,
      })
      .from(channelFolders)
      .where(whereExpr)
      .orderBy(desc(channelFolders.createdAt))

    return {
      folders: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    }
  }

  async createFolder(
    target: { channelId?: string; conversationId?: string },
    userId: string,
    name: string,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)
    const trimmed = name.trim()
    try {
      const [row] = await this.db
        .insert(channelFolders)
        .values({
          id: randomUUID(),
          channelId: target.channelId ?? null,
          conversationId: target.conversationId ?? null,
          name: trimmed,
          createdById: userId,
        })
        .returning()
      if (!row) throw new ConflictException('Could not create folder')
      void this.broadcastService.broadcastFoldersSync(
        { channelId: target.channelId, conversationId: target.conversationId },
        workspaceId,
        { folderAction: 'created' },
      )
      return {
        folder: {
          id: row.id,
          channelId: row.channelId,
          conversationId: row.conversationId,
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
    target: { channelId?: string; conversationId?: string },
    folderId: string,
    userId: string,
    name: string,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)
    await this.assertFolderInTarget(folderId, target)
    const trimmed = name.trim()
    try {
      const [row] = await this.db
        .update(channelFolders)
        .set({ name: trimmed, updatedAt: new Date() })
        .where(eq(channelFolders.id, folderId))
        .returning()
      if (!row) throw new NotFoundException('Folder not found')
      void this.broadcastService.broadcastFoldersSync(
        { channelId: target.channelId, conversationId: target.conversationId },
        workspaceId,
        { folderAction: 'updated', folderId },
      )
      return {
        folder: {
          id: row.id,
          channelId: row.channelId,
          conversationId: row.conversationId,
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

  async deleteFolder(
    target: { channelId?: string; conversationId?: string },
    folderId: string,
    userId: string,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)
    await this.assertFolderInTarget(folderId, target)
    await this.db.delete(channelFolders).where(eq(channelFolders.id, folderId))
    void this.broadcastService.broadcastFoldersSync(
      { channelId: target.channelId, conversationId: target.conversationId },
      workspaceId,
      { folderAction: 'deleted', folderId },
    )
    return { deleted: true, folderId }
  }

  async listFolderAttachments(
    target: { channelId?: string; conversationId?: string },
    folderId: string,
    userId: string,
    cursor?: string,
    limit = FOLDER_ATTACHMENTS_PAGE_SIZE,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)
    await this.assertFolderInTarget(folderId, target)

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
      target.channelId
        ? eq(messages.channelId, target.channelId)
        : eq(messages.conversationId, target.conversationId!),
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
        conversationId: messages.conversationId,
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
      .innerJoin(users, eq(messages.userId, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, messages.userId),
        ),
      )
      .where(whereExpr)
      .orderBy(desc(folderAttachments.addedAt), desc(folderAttachments.id))
      .limit(limit + 1)) as FolderLinkRow[]

    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const fileRows: ChannelFileJoinRow[] = pageRows.map((row) => {
      const rest = { ...row }
      delete (rest as Record<string, any>)['linkId']
      delete (rest as Record<string, any>)['linkAddedAt']
      return rest
    })
    const results = await this.mapFileJoinRowsToHits(fileRows)

    const last = pageRows[pageRows.length - 1]
    const nextCursor =
      hasMore && last
        ? `${last.linkAddedAt.toISOString()}__${last.linkId}`
        : null

    return { results, nextCursor, hasMore }
  }

  async addAttachmentToFolder(
    target: { channelId?: string; conversationId?: string },
    folderId: string,
    userId: string,
    attachmentId: string,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)
    await this.assertFolderInTarget(folderId, target)

    const [attRow] = await this.db
      .select({
        id: attachments.id,
        messageId: attachments.messageId,
        channelId: messages.channelId,
        conversationId: messages.conversationId,
        deletedAt: messages.deletedAt,
      })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .where(eq(attachments.id, attachmentId))
      .limit(1)

    if (!attRow) throw new NotFoundException('Attachment not found')
    if (target.channelId && attRow.channelId !== target.channelId)
      throw new ForbiddenException('Attachment is not in this channel')
    if (
      target.conversationId &&
      attRow.conversationId !== target.conversationId
    )
      throw new ForbiddenException('Attachment is not in this conversation')

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

    void this.broadcastService.broadcastFoldersSync(
      { channelId: target.channelId, conversationId: target.conversationId },
      workspaceId,
      { folderAction: 'attachments', folderId },
    )

    return { ok: true, folderId, attachmentId }
  }

  async removeAttachmentFromFolder(
    target: { channelId?: string; conversationId?: string },
    folderId: string,
    userId: string,
    attachmentId: string,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)
    await this.assertFolderInTarget(folderId, target)

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

    void this.broadcastService.broadcastFoldersSync(
      { channelId: target.channelId, conversationId: target.conversationId },
      workspaceId,
      { folderAction: 'attachments', folderId },
    )

    return { ok: true, folderId, attachmentId }
  }

  /**
   * Client đã upload binary lên S3/Cloudinary — lưu DB và gắn vào folder.
   * Tạo message `system` + content `<p></p>` để gắn attachment (message_id NOT NULL);
   * client ẩn `type === 'system'` khỏi timeline chat.
   */
  async uploadFileToFolder(
    target: { channelId?: string; conversationId?: string },
    folderId: string,
    userId: string,
    dto: UploadFileToFolderDto,
  ) {
    const { workspaceId } = await this.assertTargetAccess(target, userId)
    await this.assertFolderInTarget(folderId, target)

    const { msg, att } = await this.db.transaction(async (tx) => {
      const [m] = (await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          channelId: target.channelId ?? null,
          conversationId: target.conversationId ?? null,
          userId,
          workspaceId,
          content: '<p></p>',
          /** Không hiển thị trong timeline chat — client lọc `type === 'system'` */
          type: 'system',
          parentId: null,
        })
        .returning()) as Array<{ id: string }>

      const [a] = await tx
        .insert(attachments)
        .values({
          id: randomUUID(),
          messageId: m.id,
          userId,
          workspaceId,
          channelId: target.channelId ?? null,
          conversationId: target.conversationId ?? null,
          url: dto.url,
          type: dto.type,
          name: dto.name,
          size: dto.size,
          mimeType: dto.mimeType ?? null,
          width: dto.width ?? null,
          height: dto.height ?? null,
          duration: dto.duration ?? null,
          originScope: 'message_body',
        })
        .returning()

      await tx.insert(folderAttachments).values({
        id: randomUUID(),
        folderId,
        attachmentId: a.id,
        addedById: userId,
      })

      return { msg: m, att: a }
    })

    const targetId = (target.channelId || target.conversationId) as string
    await this.redis.del(this.messageCacheKey(targetId))

    const enriched = await this.enrichAttachmentWithSignedUrl({
      ...att,
      name: att.name,
    })
    const createdAt =
      enriched.createdAt instanceof Date
        ? enriched.createdAt.toISOString()
        : String(enriched.createdAt)

    const attachmentPayload = {
      ...enriched,
      createdAt,
    }
    const room = this.folderChatRoom(target)
    void this.broadcastService.broadcastAttachmentAdded(
      room,
      { messageId: msg.id, attachment: attachmentPayload },
      undefined,
      undefined,
      undefined,
      workspaceId,
    )
    void this.broadcastService.broadcastFoldersSync(
      { channelId: target.channelId, conversationId: target.conversationId },
      workspaceId,
      { folderAction: 'attachments', folderId },
    )

    return {
      messageId: msg.id,
      attachment: attachmentPayload,
    }
  }
}
