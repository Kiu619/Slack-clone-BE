import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { randomUUID } from 'crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  scheduledMessages,
  workspaceMembers,
  type NewScheduledMessage,
} from '../database/schema'
import { MessageService } from '../message/message.service'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
import { UnifiedBroadcastService } from '../chat/unified-broadcast.service'
import type {
  CreateScheduledMessageDto,
  UpdateScheduledMessageDto,
} from './dto/scheduled-message.dto'

const MIN_LEAD_MS = 60_000
const BULL_DELAY_MAX = 2147483647

function jobIdForScheduledRow(id: string) {
  return `sched-msg-${id}`
}

function plainFromHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim()
}

@Injectable()
export class ScheduledMessageService {
  private readonly logger = new Logger(ScheduledMessageService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly messageService: MessageService,
    private readonly chatBroadcast: ChatBroadcastService,
    private readonly unifiedBroadcast: UnifiedBroadcastService,
    @InjectQueue('scheduled-messages') private readonly queue: Queue,
  ) {}

  private async assertMember(workspaceId: string, userId: string) {
    const [row] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)
    if (!row) {
      throw new ForbiddenException('Not a member of this workspace')
    }
  }

  private broadcastListSync(
    userId: string,
    workspaceId: string,
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcast.broadcastToUser(
      userId,
      workspaceId,
      'scheduled:sync',
      { workspaceId },
      excludeSocketId,
    )
  }

  async list(
    workspaceId: string,
    userId: string,
    status?: 'pending' | 'cancelled' | 'all',
  ) {
    await this.assertMember(workspaceId, userId)
    const st = status ?? 'all'
    const baseWhere = and(
      eq(scheduledMessages.workspaceId, workspaceId),
      eq(scheduledMessages.userId, userId),
    )
    const whereExpr =
      st === 'all'
        ? baseWhere
        : and(baseWhere, eq(scheduledMessages.status, st))

    if (st === 'pending') {
      return this.db
        .select()
        .from(scheduledMessages)
        .where(whereExpr)
        .orderBy(asc(scheduledMessages.scheduledAt))
    }
    return this.db
      .select()
      .from(scheduledMessages)
      .where(whereExpr)
      .orderBy(desc(scheduledMessages.updatedAt))
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateScheduledMessageDto,
    excludeSocketId?: string,
  ) {
    await this.assertMember(workspaceId, userId)
    if (!plainFromHtml(dto.content)) {
      throw new BadRequestException('Nội dung không được để trống')
    }
    const when = new Date(dto.scheduledAt)
    this.assertScheduledAtWindow(when)

    const id = randomUUID()
    const row: NewScheduledMessage = {
      id,
      userId,
      workspaceId,
      channelId: dto.channelId ?? null,
      conversationId: dto.conversationId ?? null,
      parentId: dto.parentId ?? null,
      content: dto.content,
      alsoSendToChannel: dto.alsoSendToChannel ?? false,
      scheduledAt: when,
      status: 'pending',
    }

    await this.db.insert(scheduledMessages).values(row)

    const delay = Math.min(
      Math.max(when.getTime() - Date.now(), 0),
      BULL_DELAY_MAX,
    )
    try {
      await this.queue.add(
        'dispatch',
        { scheduledMessageId: id },
        {
          delay,
          jobId: jobIdForScheduledRow(id),
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        },
      )
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(`Queue add failed: ${msg}`)
      await this.db
        .delete(scheduledMessages)
        .where(eq(scheduledMessages.id, id))
      throw new BadRequestException('Không thể lên lịch hàng đợi')
    }

    this.broadcastListSync(userId, workspaceId, excludeSocketId)
    const [created] = await this.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, id))
      .limit(1)
    return created
  }

  async cancel(
    workspaceId: string,
    userId: string,
    id: string,
    excludeSocketId?: string,
  ) {
    await this.assertMember(workspaceId, userId)
    const [row] = await this.db
      .select()
      .from(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.id, id),
          eq(scheduledMessages.workspaceId, workspaceId),
          eq(scheduledMessages.userId, userId),
        ),
      )
      .limit(1)
    if (!row) throw new NotFoundException('Không tìm thấy')
    if (row.status !== 'pending') {
      throw new BadRequestException('Chỉ hủy được tin đang chờ gửi')
    }
    await this.db
      .update(scheduledMessages)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(scheduledMessages.id, id))

    try {
      const job = await this.queue.getJob(jobIdForScheduledRow(id))
      await job?.remove()
    } catch {
      /* job có thể đã chạy */
    }

    this.broadcastListSync(userId, workspaceId, excludeSocketId)
    return { ok: true as const }
  }

  private assertScheduledAtWindow(when: Date) {
    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('scheduledAt không hợp lệ')
    }
    const minAt = new Date(Date.now() + MIN_LEAD_MS)
    if (when.getTime() < minAt.getTime()) {
      throw new BadRequestException(
        'Thời gian gửi phải cách hiện tại ít nhất 1 phút',
      )
    }
    const maxAt = new Date(Date.now() + BULL_DELAY_MAX)
    if (when.getTime() > maxAt.getTime()) {
      throw new BadRequestException(
        'Thời gian lên lịch quá xa (tối đa khoảng 24 ngày do giới hạn hàng đợi)',
      )
    }
  }

  async reschedule(
    workspaceId: string,
    userId: string,
    id: string,
    dto: UpdateScheduledMessageDto,
    excludeSocketId?: string,
  ) {
    await this.assertMember(workspaceId, userId)
    const [row] = await this.db
      .select()
      .from(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.id, id),
          eq(scheduledMessages.workspaceId, workspaceId),
          eq(scheduledMessages.userId, userId),
        ),
      )
      .limit(1)
    if (!row) throw new NotFoundException('Không tìm thấy')
    if (row.status !== 'pending') {
      throw new BadRequestException('Chỉ đổi lịch được tin đang chờ gửi')
    }

    const when = new Date(dto.scheduledAt)
    this.assertScheduledAtWindow(when)

    const prevScheduledAt = row.scheduledAt

    try {
      const job = await this.queue.getJob(jobIdForScheduledRow(id))
      await job?.remove()
    } catch {
      /* noop */
    }

    await this.db
      .update(scheduledMessages)
      .set({ scheduledAt: when, updatedAt: new Date() })
      .where(eq(scheduledMessages.id, id))

    const delay = Math.min(
      Math.max(when.getTime() - Date.now(), 0),
      BULL_DELAY_MAX,
    )
    try {
      await this.queue.add(
        'dispatch',
        { scheduledMessageId: id },
        {
          delay,
          jobId: jobIdForScheduledRow(id),
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        },
      )
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(`Queue reschedule add failed: ${msg}`)
      await this.db
        .update(scheduledMessages)
        .set({
          scheduledAt: prevScheduledAt,
          updatedAt: new Date(),
        })
        .where(eq(scheduledMessages.id, id))
      const rollbackDelay = Math.min(
        Math.max(new Date(prevScheduledAt).getTime() - Date.now(), 0),
        BULL_DELAY_MAX,
      )
      try {
        await this.queue.add(
          'dispatch',
          { scheduledMessageId: id },
          {
            delay: rollbackDelay,
            jobId: jobIdForScheduledRow(id),
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
          },
        )
      } catch {
        /* best effort */
      }
      throw new BadRequestException('Không thể cập nhật hàng đợi')
    }

    this.broadcastListSync(userId, workspaceId, excludeSocketId)
    const [updated] = await this.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, id))
      .limit(1)
    return updated
  }

  async dispatch(scheduledMessageId: string) {
    const [row] = await this.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, scheduledMessageId))
      .limit(1)
    if (!row || row.status !== 'pending') {
      this.logger.warn(
        `Dispatch skip: ${scheduledMessageId} missing or not pending`,
      )
      return
    }

    const userId = row.userId
    const dto = {
      content: row.content,
      parentId: row.parentId ?? undefined,
      alsoSendToChannel: row.alsoSendToChannel,
    }
    const params = row.channelId
      ? { channelId: row.channelId }
      : { conversationId: row.conversationId! }

    const message = await this.messageService.createMessage(params, userId, dto)

    const room = row.channelId
      ? `channel:${row.channelId}`
      : `conversation:${row.conversationId}`
    this.chatBroadcast.broadcastMessage(room, message, undefined)

    await this.db
      .update(scheduledMessages)
      .set({
        status: 'sent',
        sentMessageId: message.id,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(scheduledMessages.id, scheduledMessageId))

    this.broadcastListSync(userId, row.workspaceId, undefined)
  }
}
