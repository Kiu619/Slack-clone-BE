import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
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

/**
 * BullMQ hard cap for delayed jobs (≈24.8 days, the max signed 32-bit int
 * in milliseconds). Anything further out is clamped to this value; the
 * processor's reminderFiredAt guard then ensures we don't notify prematurely.
 */
const BULL_DELAY_MAX = 2147483647

/** Stable BullMQ jobId per saved-item id — re-scheduling replaces the old job. */
function jobIdForSavedItem(id: string) {
  return `later-reminder-${id}`
}

@Injectable()
export class LaterService {
  private readonly logger = new Logger(LaterService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly s3Service: S3Service,
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
    private readonly broadcastService: ChatBroadcastService,
    @InjectQueue('later-reminders')
    private readonly reminderQueue: Queue,
  ) {}

  /**
   * (Re)schedule a BullMQ job for the reminder time of a saved item.
   * Uses the saved-item id as the BullMQ jobId, so re-scheduling is
   * idempotent — old jobs for the same item are replaced, not duplicated.
   * No-op when `remindAt` is missing/in the past (the processor will pick
   * up missed reminders immediately thanks to its `remindAt <= NOW()` guard
   * combined with the partial index).
   */
  private async scheduleReminderJob(item: {
    id: string
    remindAt: Date | string | null
  }): Promise<void> {
    if (!item.remindAt) return
    const remindAt =
      item.remindAt instanceof Date ? item.remindAt : new Date(item.remindAt)
    if (Number.isNaN(remindAt.getTime())) return

    const delay = Math.min(
      Math.max(remindAt.getTime() - Date.now(), 0),
      BULL_DELAY_MAX,
    )
    try {
      await this.reminderQueue.add(
        'fire-reminder',
        { savedItemId: item.id },
        {
          delay,
          jobId: jobIdForSavedItem(item.id),
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        },
      )
    } catch (e) {
      // Don't fail the user-facing mutation if BullMQ is briefly unavailable;
      // the processor's idempotency guarantees no double-fire on retry.
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(
        `Failed to schedule reminder for ${item.id}: ${msg}`,
      )
    }
  }

  /**
   * Cancel a previously-scheduled reminder. Safe to call even when no job
   * exists (e.g. item was just inserted with no remindAt yet, or the user
   * already completed the reminder).
   */
  private async cancelReminderJob(itemId: string): Promise<void> {
    try {
      const job = await this.reminderQueue.getJob(jobIdForSavedItem(itemId))
      if (job) await job.remove()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.warn(`Failed to cancel reminder ${itemId}: ${msg}`)
    }
  }

  /**
   * Chuyển S3 URL thành presigned URL (signed URL)
   */
  private async getSignedUrl(
    url: string | null,
    name?: string,
  ): Promise<string | null> {
    if (!url) return url
    const key = this.s3Service.parseS3KeyFromUrl(url)
    if (!key) return url
    try {
      return await this.s3Service.getPresignedGetUrl(key, 86400, name)
    } catch {
      return url
    }
  }

  /**
   * Single round-trip for POST check-messages:
   * - savedMessageIds: message IDs that are directly saved (type='message')
   * - remindAtByMessageId: earliest reminder time for each directly-saved message
   * - savedAttachmentIds: attachment IDs that are saved (type='attachment')
   *
   * Note: attachments and messages are tracked SEPARATELY. Saving an attachment
   * does NOT cause its parent message to appear in savedMessageIds.
   */
  async checkLaterMessagesForUser(
    userId: string,
    workspaceId: string,
    messageIds: string[],
  ): Promise<{
    savedMessageIds: string[]
    remindAtByMessageId: Record<string, string>
    savedAttachmentIds: string[]
  }> {
    if (messageIds.length === 0) {
      return { savedMessageIds: [], remindAtByMessageId: {}, savedAttachmentIds: [] }
    }

    const idList = sql.join(
      messageIds.map((id) => sql`${id}`),
      sql`, `,
    )

    // Query 1: only directly-saved messages (type='message')
    const messageRows = await this.db.execute(sql`
      SELECT
        si.message_id::text AS "messageId",
        (MIN(si.remind_at) FILTER (WHERE si.remind_at IS NOT NULL)) AS "soonestRemind"
      FROM saved_items si
      WHERE si.user_id = ${userId}
        AND si.workspace_id = ${workspaceId}
        AND si.status = 'in_progress'
        AND si.type = 'message'
        AND si.message_id IS NOT NULL
        AND si.message_id IN (${idList})
      GROUP BY si.message_id
    `)

    type MessageRow = { messageId: string; soonestRemind: Date | string | null }
    const messageList = messageRows as unknown as MessageRow[]

    const savedMessageIds: string[] = []
    const remindAtByMessageId: Record<string, string> = {}

    for (const r of messageList) {
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

    // Query 2: saved attachments whose parent message is in the idList
    const attachmentRows = await this.db.execute(sql`
      SELECT si.attachment_id::text AS "attachmentId"
      FROM saved_items si
      INNER JOIN attachments a ON si.attachment_id = a.id
      WHERE si.user_id = ${userId}
        AND si.workspace_id = ${workspaceId}
        AND si.status = 'in_progress'
        AND si.type = 'attachment'
        AND si.attachment_id IS NOT NULL
        AND a.message_id IN (${idList})
    `)

    type AttachmentRow = { attachmentId: string }
    const attachmentList = attachmentRows as unknown as AttachmentRow[]
    const savedAttachmentIds = attachmentList
      .map((r) => r?.attachmentId)
      .filter(Boolean)

    return { savedMessageIds, remindAtByMessageId, savedAttachmentIds }
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

    const ids = [
      ...new Set([
        ...directRows.map((r) => r.id),
        ...attachmentRows.map((r) => r.id),
      ]),
    ]
    for (const itemId of ids) {
      await this.removeItem(userId, itemId)
    }
    return { success: true, removed: ids.length }
  }

  /**
   * Remove all in_progress Later rows for a specific attachment.
   * Used when user clicks "Remove from Later" on an attachment in FileToolbar.
   */
  async removeInProgressItemsForAttachment(
    userId: string,
    workspaceId: string,
    attachmentId: string,
  ): Promise<{ success: true; removed: number }> {
    const rows = await this.db
      .select({ id: savedItems.id })
      .from(savedItems)
      .where(
        and(
          eq(savedItems.userId, userId),
          eq(savedItems.workspaceId, workspaceId),
          eq(savedItems.status, 'in_progress'),
          eq(savedItems.type, 'attachment'),
          eq(savedItems.attachmentId, attachmentId),
        ),
      )

    const ids = rows.map((r) => r.id)
    for (const itemId of ids) {
      await this.removeItem(userId, itemId)
    }
    return { success: true, removed: ids.length }
  }

  async purgeAllItemsForMessage(
    workspaceId: string,
    messageId: string,
  ): Promise<{ success: true; removed: number }> {
    const directRows = await this.db
      .select({ id: savedItems.id })
      .from(savedItems)
      .where(
        and(
          eq(savedItems.workspaceId, workspaceId),
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
          eq(savedItems.workspaceId, workspaceId),
          eq(savedItems.type, 'attachment'),
          eq(attachments.messageId, messageId),
        ),
      )

    const ids = [
      ...new Set([
        ...directRows.map((r) => r.id),
        ...attachmentRows.map((r) => r.id),
      ]),
    ]
    if (ids.length === 0) {
      return { success: true, removed: 0 }
    }

    const deletedRows = await this.db
      .delete(savedItems)
      .where(inArray(savedItems.id, ids))
      .returning({
        id: savedItems.id,
        userId: savedItems.userId,
        workspaceId: savedItems.workspaceId,
      })

    for (const row of deletedRows) {
      // Best-effort cancel any pending reminder job for the purged row.
      void this.cancelReminderJob(row.id)
      this.broadcastService.broadcastToUser(
        row.userId,
        row.workspaceId,
        'later:removed',
        {
          itemId: row.id,
          workspaceId: row.workspaceId,
        },
      )
    }

    return { success: true, removed: deletedRows.length }
  }

  async purgeAllItemsForAttachment(
    workspaceId: string,
    attachmentId: string,
  ): Promise<{ success: true; removed: number }> {
    const deletedRows = await this.db
      .delete(savedItems)
      .where(
        and(
          eq(savedItems.workspaceId, workspaceId),
          eq(savedItems.type, 'attachment'),
          eq(savedItems.attachmentId, attachmentId),
        ),
      )
      .returning({
        id: savedItems.id,
        userId: savedItems.userId,
        workspaceId: savedItems.workspaceId,
      })

    for (const row of deletedRows) {
      void this.cancelReminderJob(row.id)
      this.broadcastService.broadcastToUser(
        row.userId,
        row.workspaceId,
        'later:removed',
        {
          itemId: row.id,
          workspaceId: row.workspaceId,
        },
      )
    }

    return { success: true, removed: deletedRows.length }
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
            await this.scheduleReminderJob(updated)
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
      await this.scheduleReminderJob(newItem)
    }
    return newItem
  }

  async removeItem(userId: string, itemId: string) {
    const [deleted] = await this.db
      .delete(savedItems)
      .where(and(eq(savedItems.id, itemId), eq(savedItems.userId, userId)))
      .returning()

    if (!deleted)
      throw new NotFoundException('Item not found in your Later list')
    // Best-effort: cancel any pending reminder job for this item so we don't
    // broadcast `later:due` for a deleted row.
    await this.cancelReminderJob(itemId)
    this.broadcastService.broadcastToUser(
      userId,
      deleted.workspaceId,
      'later:removed',
      {
        itemId,
        workspaceId: deleted.workspaceId,
      },
    )
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

    this.broadcastService.broadcastToUser(
      userId,
      workspaceId,
      'later:cleared_completed',
      { workspaceId },
    )
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
    // Reschedule the BullMQ reminder based on the latest state:
    //  - status flipped away from `in_progress` (completed/archived) → cancel
    //  - `remindAt` cleared (null)                       → cancel
    //  - `remindAt` is still set and status is in_progress → re-schedule
    const isActive = updated.status === 'in_progress'
    if (!isActive || !updated.remindAt) {
      await this.cancelReminderJob(itemId)
    } else {
      await this.scheduleReminderJob(updated)
    }
    this.broadcastService.broadcastToUser(
      userId,
      updated.workspaceId,
      'later:updated',
      updated,
    )
    return updated
  }

  async getLaterSummary(userId: string, workspaceId: string) {
    const baseWhereClause = and(
      eq(savedItems.userId, userId),
      eq(savedItems.workspaceId, workspaceId),
      eq(savedItems.status, 'in_progress'),
      sql`${savedItems.remindAt} IS NOT NULL`,
    )

    const [{ overdueCount }] = await this.db
      .select({
        overdueCount: sql<number>`COUNT(*)`,
      })
      .from(savedItems)
      .where(and(baseWhereClause, sql`${savedItems.remindAt} <= NOW()`))

    const [nextOverdueRow] = await this.db
      .select({
        nextOverdueAt: sql<Date | null>`MIN(${savedItems.remindAt})`,
      })
      .from(savedItems)
      .where(and(baseWhereClause, sql`${savedItems.remindAt} > NOW()`))

    return {
      overdueCount: Number(overdueCount ?? 0),
      nextOverdueAt: nextOverdueRow?.nextOverdueAt
        ? new Date(nextOverdueRow.nextOverdueAt).toISOString()
        : null,
    }
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

    let baseWhereClause = and(
      eq(savedItems.userId, userId),
      eq(savedItems.workspaceId, workspaceId),
      status ? eq(savedItems.status, status) : undefined,
    )

    if (hideUpcoming && status === 'in_progress') {
      baseWhereClause = and(
        baseWhereClause,
        sql`(${savedItems.remindAt} IS NULL OR ${savedItems.remindAt} <= NOW())`,
      )
    }

    const [{ totalCount }] = await this.db
      .select({
        totalCount: sql<number>`COUNT(*)`,
      })
      .from(savedItems)
      .where(baseWhereClause)

    let whereClause = baseWhereClause

    if (cursor) {
      const colonIdx = cursor.indexOf(':')
      const pStr = cursor.slice(0, colonIdx)
      const tsStr = cursor.slice(colonIdx + 1)
      const p = parseInt(pStr, 10)
      const ts = new Date(tsStr)

      whereClause = and(
        whereClause,
        sql`(${prioritySql} > ${p} OR (${prioritySql} = ${p} AND ${savedItems.createdAt} < ${ts.toISOString()}))`,
      )
    }

    const query = this.db
      .select()
      .from(savedItems)
      .where(whereClause)
      .orderBy(sql`${prioritySql} ASC`, desc(savedItems.createdAt))
      .limit(limit)

    const rows = await query

    // 1. Collect all message IDs from both saved messages and attachments
    const messageIds = new Set<string>()
    rows.forEach((r) => {
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
                wmId: workspaceMembers.id,
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
    attachmentsData.forEach((a) => {
      if (a.attachment.messageId) {
        messageIds.add(a.attachment.messageId)
      }
    })

    // 3. Fetch all messages in one go (including those for attachments)
    const messageIdsArray = Array.from(messageIds)
    const messagesMapRaw =
      messageIdsArray.length > 0
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

    const parentMessagesMapRaw =
      parentIds.length > 0
        ? await this.messageService.getMessagesByIds(parentIds, userId)
        : new Map<string, any>()

    const messagesMap = new Map(
      messagesData.map((m) => {
        const parentMessage = m.parentId
          ? messagesMapRaw.get(m.parentId) ||
            parentMessagesMapRaw.get(m.parentId) ||
            null
          : null

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
              wmId: workspaceMembers.id,
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
    const reminderUsersMap = new Map(reminderUsers.map((u) => [u.id, u]))

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
            const associatedMessage = att.attachment.messageId
              ? messagesMap.get(att.attachment.messageId)
              : null
            attachment = {
              ...att.attachment,
              url: await this.getSignedUrl(
                att.attachment.url,
                att.attachment.name,
              ),
              user: {
                id: att.user.id,
                name:
                  att.user.wmId == null
                    ? 'Deleted user'
                    : att.user.wmName || att.user.name,
                displayName:
                  att.user.wmId == null
                    ? 'Deleted user'
                    : att.user.displayName,
                avatar:
                  att.user.wmId == null
                    ? null
                    : att.user.wmAvatar || att.user.avatar,
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
              name: u.wmId == null ? 'Deleted user' : u.wmName || u.name,
              displayName: u.wmId == null ? 'Deleted user' : u.displayName,
              avatar: u.wmId == null ? null : u.wmAvatar || u.avatar,
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
      totalCount: Number(totalCount ?? 0),
    }
  }
}
