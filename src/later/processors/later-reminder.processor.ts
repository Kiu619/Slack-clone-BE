import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../../database/database.module'
import { savedItems, type SavedItem } from '../../database/schema'
import { ChatBroadcastService } from '../../chat/chat-broadcast.service'

/**
 * Payload for a `fire-reminder` job. The job id is derived from the saved
 * item id so that re-scheduling a reminder (e.g. user changes `remindAt`)
 * replaces the previous job deterministically without leaving orphans.
 */
export type FireReminderJobData = {
  savedItemId: string
}

/**
 * BullMQ worker for the `later-reminders` queue.
 *
 * When a reminder's `remindAt` time arrives:
 * 1. Re-fetch the saved item from the DB (source of truth) — it might have
 *    been completed, archived, deleted, or have its reminder cleared between
 *    scheduling and execution.
 * 2. Bail out silently if the item is no longer eligible (already completed,
 *    already fired, or `remindAt` cleared).
 * 3. Otherwise, set `reminderFiredAt = NOW()` so we never fire twice.
 * 4. Broadcast a `later:due` event via Socket.io to the user. The frontend
 *    `useGlobalSync` handler converts that into a browser desktop notification
 *    (gated by the user's `desktopNotificationsEnabled` preference and OS
 *    permission).
 */
@Processor('later-reminders')
export class LaterReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(LaterReminderProcessor.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly broadcastService: ChatBroadcastService,
  ) {
    super()
  }

  async process(
    job: Job<FireReminderJobData, void, string>,
  ): Promise<void> {
    if (job.name !== 'fire-reminder') {
      this.logger.warn(`Unknown job name: ${job.name}`)
      return
    }
    await this.handleFireReminder(job.data.savedItemId)
  }

  private async handleFireReminder(savedItemId: string): Promise<void> {
    // 1. Atomically claim the reminder by transitioning
    //    `reminderFiredAt` from NULL → NOW(). The `IS NULL` guard ensures
    //    that retries (e.g. worker crash + BullMQ replay) cannot fire the
    //    same notification twice.
    const claimed = await this.db
      .update(savedItems)
      .set({ reminderFiredAt: sql`NOW()` })
      .where(
        and(
          eq(savedItems.id, savedItemId),
          eq(savedItems.status, 'in_progress'),
          isNull(savedItems.reminderFiredAt),
          // Guard against the user clearing `remindAt` between scheduling
          // and firing — we still mark fired so the row stays consistent,
          // but only broadcast if a reminder time actually exists.
          lte(savedItems.remindAt, sql`NOW()`),
        ),
      )
      .returning()

    const item = claimed[0] as SavedItem | undefined
    if (!item) {
      this.logger.debug(
        `Reminder ${savedItemId} skipped (already fired, completed, or remindAt cleared)`,
      )
      return
    }

    this.logger.log(
      `Reminder fired for saved_item=${item.id} user=${item.userId} workspace=${item.workspaceId}`,
    )

    // 2. Push the realtime event so connected tabs show a desktop notification
    //    AND refresh their saved-items cache so the badge count goes up.
    this.broadcastService.broadcastToUser(
      item.userId,
      item.workspaceId,
      'later:due',
      {
        id: item.id,
        workspaceId: item.workspaceId,
        type: item.type,
        note: item.note,
        remindAt:
          item.remindAt instanceof Date
            ? item.remindAt.toISOString()
            : item.remindAt,
        // Keep the payload small — the frontend will refetch full details
        // (message/attachment) on demand if the user opens the item.
        messageId: item.messageId,
        attachmentId: item.attachmentId,
      },
    )
  }
}
