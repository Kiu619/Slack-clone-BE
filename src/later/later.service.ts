import { Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  attachments,
  savedItems,
  users,
  workspaceMembers,
  channels,
  directMessageConversations,
  conversationMembers,
} from '../database/schema'
import { S3Service } from '../upload/s3.service'
import type { SaveItemDto, UpdateLaterItemDto } from './dto/later.dto'
import { MessageService } from '../message/message.service'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'

@Injectable()
export class LaterService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly s3Service: S3Service,
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
    private readonly broadcastService: ChatBroadcastService,
  ) { }

  /**
   * Chuyển S3 URL thành presigned URL (signed URL)
   */
  private async getSignedUrl(url: string, name?: string): Promise<string> {
    const key = this.s3Service.parseS3KeyFromUrl(url)
    if (!key) return url
    try {
      return await this.s3Service.getPresignedGetUrl(key, 86400, name)
    } catch {
      return url
    }
  }

  /**
   * Single round-trip for POST check-messages: which message IDs are in Later
   * (in_progress, message or attachment save) and the soonest non-null remindAt per message.
   */
  async checkLaterMessagesForUser(
    userId: string,
    workspaceId: string,
    messageIds: string[],
  ): Promise<{ savedMessageIds: string[]; remindAtByMessageId: Record<string, string> }> {
    if (messageIds.length === 0) {
      return { savedMessageIds: [], remindAtByMessageId: {} }
    }

    const idList = sql.join(
      messageIds.map((id) => sql`${id}`),
      sql`, `,
    )

    const rows = await this.db.execute(sql`
      WITH unioned AS (
        SELECT si.message_id AS message_id, si.remind_at AS remind_at
        FROM saved_items si
        WHERE si.user_id = ${userId}
          AND si.workspace_id = ${workspaceId}
          AND si.status = 'in_progress'
          AND si.type = 'message'
          AND si.message_id IS NOT NULL
          AND si.message_id IN (${idList})
        UNION ALL
        SELECT a.message_id AS message_id, si.remind_at AS remind_at
        FROM saved_items si
        INNER JOIN attachments a ON si.attachment_id = a.id
        WHERE si.user_id = ${userId}
          AND si.workspace_id = ${workspaceId}
          AND si.status = 'in_progress'
          AND si.type = 'attachment'
          AND si.attachment_id IS NOT NULL
          AND a.message_id IN (${idList})
      )
      SELECT message_id::text AS "messageId",
        (MIN(remind_at) FILTER (WHERE remind_at IS NOT NULL)) AS "soonestRemind"
      FROM unioned
      GROUP BY message_id
    `)

    type Row = { messageId: string; soonestRemind: Date | string | null }
    const list = rows as unknown as Row[]

    const savedMessageIds: string[] = []
    const remindAtByMessageId: Record<string, string> = {}

    for (const r of list) {
      if (!r?.messageId) continue
      savedMessageIds.push(r.messageId)
      if (r.soonestRemind != null) {
        const d =
          r.soonestRemind instanceof Date
            ? r.soonestRemind
            : new Date(String(r.soonestRemind))
        if (!Number.isNaN(d.getTime())) {
          remindAtByMessageId[r.messageId] = d.toISOString()
        }
      }
    }

    return { savedMessageIds, remindAtByMessageId }
  }

  /**
   * Remove all in_progress Later rows tied to this message (direct message save
   * or attachment save on this message). Idempotent when nothing matches.
   */
  async removeInProgressItemsForMessage(
    userId: string,
    workspaceId: string,
    messageId: string,
  ): Promise<{ success: true; removed: number }> {
    const base = and(
      eq(savedItems.userId, userId),
      eq(savedItems.workspaceId, workspaceId),
      eq(savedItems.status, 'in_progress'),
    )

    const directRows = await this.db
      .select({ id: savedItems.id })
      .from(savedItems)
      .where(
        and(
          base,
          eq(savedItems.type, 'message'),
          eq(savedItems.messageId, messageId),
        ),
      )

    const attachmentRows = await this.db
      .select({ id: savedItems.id })
      .from(savedItems)
      .innerJoin(attachments, eq(savedItems.attachmentId, attachments.id))
      .where(
        and(
          base,
          eq(savedItems.type, 'attachment'),
          eq(attachments.messageId, messageId),
        ),
      )

    const ids = [...new Set([...directRows.map((r) => r.id), ...attachmentRows.map((r) => r.id)])]
    for (const itemId of ids) {
      await this.removeItem(userId, itemId)
    }
    return { success: true, removed: ids.length }
  }

  async saveItem(userId: string, workspaceId: string, dto: SaveItemDto) {
    const { type, messageId, attachmentId, note, remindAt } = dto

    // Kiểm tra xem đã tồn tại chưa (chỉ cho message/attachment, reminder luôn cho tạo mới)
    if (type !== 'reminder') {
      const [existing] = await this.db
        .select()
        .from(savedItems)
        .where(
          and(
            eq(savedItems.userId, userId),
            eq(savedItems.workspaceId, workspaceId),
            type === 'message'
              ? eq(savedItems.messageId, messageId!)
              : eq(savedItems.attachmentId, attachmentId!),
          ),
        )
        .limit(1)

      if (existing) {
        if (remindAt) {
          const [updated] = await this.db
            .update(savedItems)
            .set({
              remindAt: new Date(remindAt),
              ...(note !== undefined ? { note: note ?? null } : {}),
            })
            .where(eq(savedItems.id, existing.id))
            .returning()
          if (updated) {
            this.broadcastService.broadcastToUser(
              userId,
              updated.workspaceId,
              'later:updated',
              updated,
            )
            return updated
          }
        }
        return existing
      }
    }

    const [newItem] = await this.db
      .insert(savedItems)
      .values({
        id: randomUUID(),
        userId,
        workspaceId,
        type,
        messageId: type === 'message' ? messageId : null,
        attachmentId: type === 'attachment' ? attachmentId : null,
        status: 'in_progress',
        note: note ?? null,
        remindAt: remindAt ? new Date(remindAt) : null,
      })
      .returning()

    if (newItem) {
      this.broadcastService.broadcastToUser(
        userId,
        newItem.workspaceId,
        'later:updated',
        newItem,
      )
    }
    return newItem
  }

  async removeItem(userId: string, itemId: string) {
    const [deleted] = await this.db
      .delete(savedItems)
      .where(and(eq(savedItems.id, itemId), eq(savedItems.userId, userId)))
      .returning()

    if (!deleted) throw new NotFoundException('Item not found in your Later list')
    this.broadcastService.broadcastToUser(userId, deleted.workspaceId, 'later:removed', {
      itemId,
      workspaceId: deleted.workspaceId,
    })
    return { success: true }
  }

  async clearCompleted(userId: string, workspaceId: string) {
    await this.db
      .delete(savedItems)
      .where(
        and(
          eq(savedItems.userId, userId),
          eq(savedItems.workspaceId, workspaceId),
          eq(savedItems.status, 'completed'),
        ),
      )

    this.broadcastService.broadcastToUser(userId, workspaceId, 'later:cleared_completed', { workspaceId })
    return { success: true }
  }

  async updateItem(userId: string, itemId: string, dto: UpdateLaterItemDto) {
    const { remindAt, ...rest } = dto
    const values: Partial<typeof savedItems.$inferInsert> = { ...rest }
    if (dto.status === 'completed') {
      values.completedAt = new Date()
    } else if (dto.status === 'in_progress' || dto.status === 'archived') {
      values.completedAt = null
    }

    if (remindAt === null) {
      values.remindAt = null
    } else if (remindAt) {
      values.remindAt = new Date(remindAt)
    }

    const [updated] = await this.db
      .update(savedItems)
      .set(values)
      .where(and(eq(savedItems.id, itemId), eq(savedItems.userId, userId)))
      .returning()

    if (!updated) throw new NotFoundException('Item not found')
    this.broadcastService.broadcastToUser(userId, updated.workspaceId, 'later:updated', updated)
    return updated
  }

  async getSavedItems(
    userId: string,
    workspaceId: string,
    status?: 'in_progress' | 'completed' | 'archived',
    cursor?: string,
    limit = 10,
    hideUpcoming = false,
  ) {
    const prioritySql = sql`CASE 
          WHEN ${savedItems.remindAt} IS NOT NULL AND ${savedItems.remindAt} <= NOW() THEN 1
          WHEN ${savedItems.remindAt} IS NOT NULL AND ${savedItems.remindAt} > NOW() THEN 2
          ELSE 3
        END`

    let whereClause = and(
      eq(savedItems.userId, userId),
      eq(savedItems.workspaceId, workspaceId),
      status ? eq(savedItems.status, status) : undefined,
    )

    if (hideUpcoming && status === 'in_progress') {
      whereClause = and(
        whereClause,
        sql`(${savedItems.remindAt} IS NULL OR ${savedItems.remindAt} <= NOW())`,
      )
    }

    if (cursor) {
      const [pStr, tsStr] = cursor.split(':')
      const p = parseInt(pStr, 10)
      const ts = new Date(tsStr)

      whereClause = and(
        whereClause,
        sql`(${prioritySql} > ${p} OR (${prioritySql} = ${p} AND ${savedItems.createdAt} < ${ts}))`,
      )
    }

    const query = this.db
      .select()
      .from(savedItems)
      .where(whereClause)
      .orderBy(
        sql`${prioritySql} ASC`,
        desc(savedItems.createdAt)
      )
      .limit(limit)

    const rows = await query

    // 1. Collect all message IDs from both saved messages and attachments
    const messageIds = new Set<string>()
    rows.forEach(r => {
      if ((r.type === 'message' || r.type === 'attachment') && r.messageId) {
        messageIds.add(r.messageId)
      }
    })

    // 2. Fetch attachment records
    const attachmentIds = rows
      .filter((r) => r.type === 'attachment' && r.attachmentId)
      .map((r) => r.attachmentId) as string[]

    const attachmentsData =
      attachmentIds.length > 0
        ? await this.db
            .select({
              attachment: attachments,
              user: {
                id: users.id,
                name: users.name,
                avatar: users.avatar,
                wmName: workspaceMembers.name,
                wmAvatar: workspaceMembers.avatar,
                displayName: workspaceMembers.displayName,
              },
              channelName: channels.name,
            })
            .from(attachments)
            .leftJoin(users, eq(attachments.userId, users.id))
            .leftJoin(
              workspaceMembers,
              and(
                eq(workspaceMembers.userId, attachments.userId),
                eq(workspaceMembers.workspaceId, workspaceId),
              ),
            )
            .leftJoin(channels, eq(attachments.channelId, channels.id))
            .where(inArray(attachments.id, attachmentIds))
        : []

    // Add messageIds from attachment records (in case row.messageId was null)
    attachmentsData.forEach(a => {
      if (a.attachment.messageId) {
        messageIds.add(a.attachment.messageId)
      }
    })

    // 3. Fetch all messages in one go (including those for attachments)
    const messageIdsArray = Array.from(messageIds)
    const messagesMapRaw = messageIdsArray.length > 0
      ? await this.messageService.getMessagesByIds(messageIdsArray, userId)
      : new Map<string, any>()

    const messagesData = Array.from(messagesMapRaw.values())

    // 4. Fetch parent messages for all messages that are replies
    const parentIds = [
      ...new Set(
        messagesData
          .filter((m) => m.parentId && !messagesMapRaw.has(m.parentId))
          .map((m) => m.parentId as string),
      ),
    ]

    const parentMessagesMapRaw = parentIds.length > 0
      ? await this.messageService.getMessagesByIds(parentIds, userId)
      : new Map<string, any>()


    const messagesMap = new Map(
      messagesData.map((m) => {
        const parentMessage = m.parentId 
          ? (messagesMapRaw.get(m.parentId) || parentMessagesMapRaw.get(m.parentId) || null)
          : null;
        
        return [
          m.id,
          {
            ...m,
            parentMessage,
            channelName: m.channelName || null,
          },
        ]
      }),
    )

    // 6. Fetch user profiles for reminders
    const reminderUserIds = rows
      .filter((r) => r.type === 'reminder')
      .map((r) => r.userId)

    const reminderUsers =
      reminderUserIds.length > 0
        ? await this.db
            .select({
              id: users.id,
              name: users.name,
              avatar: users.avatar,
              wmName: workspaceMembers.name,
              wmAvatar: workspaceMembers.avatar,
              displayName: workspaceMembers.displayName,
            })
            .from(users)
            .leftJoin(
              workspaceMembers,
              and(
                eq(workspaceMembers.userId, users.id),
                eq(workspaceMembers.workspaceId, workspaceId),
              ),
            )
            .where(inArray(users.id, reminderUserIds))
        : []
    const reminderUsersMap = new Map(
      reminderUsers.map((u) => [u.id, u]),
    )


    const attachmentsMap = new Map(
      attachmentsData.map((a) => [a.attachment.id, a]),
    )

    // 4. Combine everything
    const items = await Promise.all(
      rows.map(async (row) => {
        const message = row.messageId ? messagesMap.get(row.messageId) : null
        let attachment: any = null

        if (row.type === 'attachment' && row.attachmentId) {
          const att = attachmentsMap.get(row.attachmentId)
          if (att) {
            const associatedMessage = att.attachment.messageId ? messagesMap.get(att.attachment.messageId) : null;
            attachment = {
              ...att.attachment,
              url: await this.getSignedUrl(att.attachment.url, att.attachment.name),
              user: {
                id: att.user.id,
                name: att.user.wmName || att.user.name,
                displayName: att.user.displayName,
                avatar: att.user.wmAvatar || att.user.avatar,
              },
              channelName: att.channelName,
              parentId: associatedMessage?.parentId || null,
              parentMessage: associatedMessage?.parentMessage || null,
            }
          }
        }

        let user: any = null
        if (row.type === 'reminder') {
          const u = reminderUsersMap.get(row.userId)
          if (u) {
            user = {
              id: u.id,
              name: u.wmName || u.name,
              displayName: u.displayName,
              avatar: u.wmAvatar || u.avatar,
            }
          }
        }

        return {
          ...row,
          message,
          attachment,
          user,
        }
      }),
    )

    let nextCursor: string | null = null
    if (rows.length === limit) {
      const lastRow = rows[rows.length - 1]
      const lastPriority = lastRow.remindAt
        ? new Date(lastRow.remindAt).getTime() <= Date.now()
          ? 1
          : 2
        : 3
      nextCursor = `${lastPriority}:${lastRow.createdAt.toISOString()}`
    }

    return {
      items,
      nextCursor,
    }
  }
}
