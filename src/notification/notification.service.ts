import { InjectQueue } from '@nestjs/bullmq'
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Queue } from 'bullmq'
import { and, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm'
import { AttachmentService } from '../attachment/attachment.service'
import {
  EntityAction,
  EntityDomain,
  UnifiedBroadcastService,
} from '../chat/unified-broadcast.service'
import type { DrizzleDB } from '../database/database.module'
import { DRIZZLE } from '../database/database.module'
import * as schema from '../database/schema'
import {
  UpdateChannelOverrideDto,
  UpdateGlobalSettingsDto,
} from './dto/update-settings.dto'
import { NotificationProcessor } from './processors/notification.processor'

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name)

  constructor(
    @InjectQueue('notification') private readonly notificationQueue: Queue,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
    private readonly attachmentService: AttachmentService,
    private readonly notificationProcessor: NotificationProcessor,
  ) {}

  private broadcastNotificationChanged(userId: string, workspaceId: string) {
    this.unifiedBroadcastService.broadcastToUser(
      userId,
      workspaceId,
      'notification:changed',
      { workspaceId },
    )
  }

  async enqueueNotificationJob(data: any) {
    try {
      await this.notificationQueue.add('notify-channel', data, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: true,
      })
    } catch (error) {
      // Redis down → process synchronously in the request
      this.logger.warn(
        `BullMQ unavailable, processing notification sync: ${error.message}`,
      )
      await this.notificationProcessor.handleNotifyChannel(data)
    }
  }

  async createReplyNotifications(params: {
    actorId: string
    workspaceId: string
    messageId: string
    parentMessageId: string
    channelId?: string | null
    conversationId?: string | null
  }) {
    const {
      actorId,
      workspaceId,
      messageId,
      parentMessageId,
      channelId,
      conversationId,
    } = params

    const subscribers = await this.db
      .select({ userId: schema.threadSubscriptions.userId })
      .from(schema.threadSubscriptions)
      .where(eq(schema.threadSubscriptions.parentMessageId, parentMessageId))

    const targetUserIds = Array.from(
      new Set(
        subscribers
          .map((subscriber) => subscriber.userId)
          .filter((userId) => userId !== actorId),
      ),
    )

    if (targetUserIds.length === 0) return []

    const inserted = await this.db
      .insert(schema.notifications)
      .values(
        targetUserIds.map((userId) => ({
          userId,
          workspaceId,
          actorId,
          type: 'reply' as const,
          messageId,
          channelId: channelId ?? null,
          conversationId: conversationId ?? null,
        })),
      )
      .returning()

    await this.broadcastNotifications(inserted, actorId, workspaceId)
    return inserted
  }

  async createReactionNotification(params: {
    actorId: string
    workspaceId: string
    messageId: string
    ownerUserId: string
    channelId?: string | null
    conversationId?: string | null
  }) {
    const {
      actorId,
      workspaceId,
      messageId,
      ownerUserId,
      channelId,
      conversationId,
    } = params

    if (ownerUserId === actorId) return null

    const [inserted] = await this.db
      .insert(schema.notifications)
      .values({
        userId: ownerUserId,
        workspaceId,
        actorId,
        type: 'reaction',
        messageId,
        channelId: channelId ?? null,
        conversationId: conversationId ?? null,
      })
      .returning()

    if (!inserted) return null

    await this.broadcastNotifications([inserted], actorId, workspaceId)
    return inserted
  }

  private async broadcastNotifications(
    notifications: Array<{
      userId: string
      workspaceId: string
      actorId: string | null
      [key: string]: unknown
    }>,
    actorId: string,
    workspaceId: string,
  ) {
    if (notifications.length === 0) return

    const actor = await this.db.query.users.findFirst({
      where: eq(schema.users.id, actorId),
      columns: { id: true, name: true, avatar: true },
    })

    for (const notification of notifications) {
      this.unifiedBroadcastService.broadcastToUser(
        notification.userId,
        workspaceId,
        'notification:new',
        {
          ...notification,
          actor,
        },
      )
    }
  }

  async getNotifications(
    userId: string,
    workspaceId: string,
    limit = 20,
    cursor?: string,
  ) {
    const whereConditions = [
      eq(schema.notifications.userId, userId),
      eq(schema.notifications.workspaceId, workspaceId),
    ]

    if (cursor) {
      whereConditions.push(lt(schema.notifications.createdAt, new Date(cursor)))
    }

    const rows = await this.db.query.notifications.findMany({
      where: and(...whereConditions),
      orderBy: [desc(schema.notifications.createdAt)],
      limit: limit + 1,
      with: {
        actor: {
          with: {
            workspaceMembers: {
              where: eq(schema.workspaceMembers.workspaceId, workspaceId),
              limit: 1,
            },
          },
        },
        channel: {
          columns: {
            id: true,
            name: true,
          },
        },
        message: {
          columns: {
            id: true,
            content: true,
            createdAt: true,
          },
        },
      },
    })

    const messageIds = rows
      .map((row) =>
        row.message && !Array.isArray(row.message)
          ? row.message.id
          : row.messageId,
      )
      .filter((id): id is string => Boolean(id))
    const attachmentsMap =
      await this.attachmentService.getAttachmentsByMessageIds(messageIds)

    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => {
      // Drizzle query inference might be ambiguous about 'one' vs 'many' relations
      const actor = row.actor

      if (!actor || Array.isArray(actor)) {
        return { ...row, actor: null }
      }

      const workspaceMember = actor.workspaceMembers?.[0]
      return {
        ...row,
        actor: {
          id: actor.id,
          name: workspaceMember
            ? workspaceMember.displayName || workspaceMember.name || actor.name
            : 'deactivated user',
          avatar: workspaceMember
            ? workspaceMember.avatar || actor.avatar
            : null,
        },
        message:
          row.message && !Array.isArray(row.message)
            ? {
                ...row.message,
                attachments: (attachmentsMap.get(row.message.id) ?? []).map(
                  (attachment) => ({
                    ...attachment,
                    createdAt:
                      attachment.createdAt instanceof Date
                        ? attachment.createdAt.toISOString()
                        : attachment.createdAt,
                  }),
                ),
              }
            : row.message,
      }
    })
    const nextCursor = hasMore
      ? items[items.length - 1].createdAt.toISOString()
      : null

    return {
      items,
      nextCursor,
      hasMore,
    }
  }

  async getUnreadCount(userId: string, workspaceId: string) {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, userId),
          eq(schema.notifications.workspaceId, workspaceId),
          eq(schema.notifications.isRead, false),
        ),
      )

    return { count: Number(result?.count || 0) }
  }

  async markAsRead(notificationId: string, userId: string) {
    const [updated] = await this.db
      .update(schema.notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.id, notificationId),
          eq(schema.notifications.userId, userId),
        ),
      )
      .returning()

    if (!updated) throw new NotFoundException('Notification not found')
    this.broadcastNotificationChanged(userId, updated.workspaceId)
    return updated
  }

  async clearNotification(notificationId: string, userId: string) {
    const [deleted] = await this.db
      .delete(schema.notifications)
      .where(
        and(
          eq(schema.notifications.id, notificationId),
          eq(schema.notifications.userId, userId),
        ),
      )
      .returning()

    if (!deleted) throw new NotFoundException('Notification not found')
    this.broadcastNotificationChanged(userId, deleted.workspaceId)
    return { success: true }
  }

  async markAllAsRead(userId: string, workspaceId: string) {
    await this.db
      .update(schema.notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.userId, userId),
          eq(schema.notifications.workspaceId, workspaceId),
          eq(schema.notifications.isRead, false),
        ),
      )

    this.broadcastNotificationChanged(userId, workspaceId)
    return { success: true }
  }

  // ─── Settings Logic ───

  async updateGlobalSettings(
    userId: string,
    workspaceId: string,
    dto: UpdateGlobalSettingsDto,
  ) {
    const [updated] = await this.db
      .update(schema.workspaceMembers)
      .set(dto)
      .where(
        and(
          eq(schema.workspaceMembers.userId, userId),
          eq(schema.workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .returning()

    if (!updated) throw new NotFoundException('Workspace member not found')
    return updated
  }

  async updateChannelOverride(
    userId: string,
    workspaceId: string,
    dto: UpdateChannelOverrideDto,
    excludeSocketId?: string,
  ) {
    if (!dto.channelId && !dto.conversationId) {
      throw new BadRequestException(
        'Either channelId or conversationId must be provided',
      )
    }

    const whereClause = and(
      eq(schema.channelNotificationOverrides.userId, userId),
      eq(schema.channelNotificationOverrides.workspaceId, workspaceId),
      dto.channelId
        ? eq(schema.channelNotificationOverrides.channelId, dto.channelId)
        : eq(
            schema.channelNotificationOverrides.conversationId,
            dto.conversationId!,
          ),
    )

    const [existing] = await this.db
      .select()
      .from(schema.channelNotificationOverrides)
      .where(whereClause)
      .limit(1)

    if (existing) {
      await this.db
        .update(schema.channelNotificationOverrides)
        .set({
          ...dto,
          mutedUntil: dto.mutedUntil ? new Date(dto.mutedUntil) : undefined,
        })
        .where(eq(schema.channelNotificationOverrides.id, existing.id))
        .returning()
    } else {
      await this.db
        .insert(schema.channelNotificationOverrides)
        .values({
          userId,
          workspaceId,
          channelId: dto.channelId,
          conversationId: dto.conversationId,
          muteChannel: dto.muteChannel ?? false,
          notifyFor: dto.notifyFor,
          mutedUntil: dto.mutedUntil ? new Date(dto.mutedUntil) : null,
        })
        .returning()
    }

    const effectiveSetting = await this.getEffectiveNotificationSetting(
      userId,
      workspaceId,
      dto.channelId,
      dto.conversationId,
    )

    this.unifiedBroadcastService.syncEntity(
      {
        userId,
        workspaceId,
      },
      {
        domain: EntityDomain.NOTIFICATION,
        action: EntityAction.UPDATE,
        payload: {
          id: effectiveSetting.targetId,
          workspaceId,
          channelId: dto.channelId,
          conversationId: dto.conversationId,
          data: effectiveSetting,
        },
      },
      excludeSocketId,
    )

    return effectiveSetting
  }

  async getEffectiveNotificationSetting(
    userId: string,
    workspaceId: string,
    channelId?: string,
    conversationId?: string,
  ) {
    if (!channelId && !conversationId) {
      throw new BadRequestException(
        'Either channelId or conversationId must be provided',
      )
    }

    if (channelId && conversationId) {
      throw new BadRequestException(
        'Only one of channelId or conversationId can be provided',
      )
    }

    const [member] = await this.db
      .select({
        notifyFor: schema.workspaceMembers.notifyFor,
        notifyOnHereMention: schema.workspaceMembers.notifyOnHereMention,
        notifyOnChannelMention: schema.workspaceMembers.notifyOnChannelMention,
      })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.userId, userId),
          eq(schema.workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    if (!member) {
      throw new NotFoundException('Workspace member not found')
    }

    const [override] = await this.db
      .select({
        id: schema.channelNotificationOverrides.id,
        notifyFor: schema.channelNotificationOverrides.notifyFor,
        muteChannel: schema.channelNotificationOverrides.muteChannel,
        mutedUntil: schema.channelNotificationOverrides.mutedUntil,
      })
      .from(schema.channelNotificationOverrides)
      .where(
        and(
          eq(schema.channelNotificationOverrides.userId, userId),
          eq(schema.channelNotificationOverrides.workspaceId, workspaceId),
          channelId
            ? eq(schema.channelNotificationOverrides.channelId, channelId)
            : eq(
                schema.channelNotificationOverrides.conversationId,
                conversationId!,
              ),
        ),
      )
      .limit(1)

    const scope = channelId ? 'channel' : 'conversation'
    const effectiveNotifyFor = override?.notifyFor ?? member.notifyFor
    const effectiveMute =
      Boolean(override?.muteChannel) ||
      Boolean(
        override?.mutedUntil && new Date(override.mutedUntil) > new Date(),
      )

    const mode = effectiveMute
      ? 'muted'
      : scope === 'conversation'
        ? 'all_messages'
        : effectiveNotifyFor === 'all_messages'
          ? 'all_messages'
          : effectiveNotifyFor === 'nothing'
            ? 'muted'
            : 'mentions_only'

    return {
      scope,
      mode,
      targetId: channelId ?? conversationId!,
      notifyFor: effectiveNotifyFor,
      muteChannel: effectiveMute,
      mutedUntil: override?.mutedUntil ?? null,
      override: override ?? null,
      defaults: member,
    }
  }

  // ─── Unread Logic ───

  async getWorkspaceUnreadCounts(userId: string, workspaceId: string) {
    const [channelCounts, conversationCounts] = await Promise.all([
      this.db
        .select({
          id: schema.channels.id,
          unreadCount: sql<number>`count(${schema.messages.id})::int`,
        })
        .from(schema.channels)
        .innerJoin(
          schema.channelMembers,
          and(
            eq(schema.channelMembers.channelId, schema.channels.id),
            eq(schema.channelMembers.userId, userId),
          ),
        )
        .leftJoin(
          schema.messages,
          and(
            eq(schema.messages.channelId, schema.channels.id),
            gt(schema.messages.createdAt, schema.channelMembers.lastReadAt),
            ne(schema.messages.userId, userId),
            isNull(schema.messages.deletedAt),
          ),
        )
        .where(eq(schema.channels.workspaceId, workspaceId))
        .groupBy(schema.channels.id),
      this.db
        .select({
          id: schema.directMessageConversations.id,
          unreadCount: sql<number>`count(${schema.messages.id})::int`,
        })
        .from(schema.directMessageConversations)
        .innerJoin(
          schema.conversationMembers,
          and(
            eq(
              schema.conversationMembers.conversationId,
              schema.directMessageConversations.id,
            ),
            eq(schema.conversationMembers.userId, userId),
          ),
        )
        .leftJoin(
          schema.messages,
          and(
            eq(
              schema.messages.conversationId,
              schema.directMessageConversations.id,
            ),
            gt(
              schema.messages.createdAt,
              schema.conversationMembers.lastReadAt,
            ),
            ne(schema.messages.userId, userId),
            isNull(schema.messages.deletedAt),
          ),
        )
        .where(eq(schema.directMessageConversations.workspaceId, workspaceId))
        .groupBy(schema.directMessageConversations.id),
    ])

    return {
      channels: channelCounts,
      conversations: conversationCounts,
    }
  }

  async markChannelAsRead(userId: string, channelId: string) {
    const [channel] = await this.db
      .select({ workspaceId: schema.channels.workspaceId })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1)

    await this.db
      .update(schema.channelMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.userId, userId),
        ),
      )
    if (channel?.workspaceId) {
      this.broadcastNotificationChanged(userId, channel.workspaceId)
    }
    return { success: true }
  }

  async markConversationAsRead(userId: string, conversationId: string) {
    const [conversation] = await this.db
      .select({ workspaceId: schema.directMessageConversations.workspaceId })
      .from(schema.directMessageConversations)
      .where(eq(schema.directMessageConversations.id, conversationId))
      .limit(1)

    await this.db
      .update(schema.conversationMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(schema.conversationMembers.conversationId, conversationId),
          eq(schema.conversationMembers.userId, userId),
        ),
      )
    if (conversation?.workspaceId) {
      this.broadcastNotificationChanged(userId, conversation.workspaceId)
    }
    return { success: true }
  }

  async getMentions(
    userId: string,
    workspaceId: string,
    limit = 20,
    cursor?: string,
  ) {
    const whereConditions = [
      eq(schema.mentions.mentionedUserId, userId),
      eq(schema.mentions.workspaceId, workspaceId),
    ]

    if (cursor) {
      whereConditions.push(lt(schema.mentions.createdAt, new Date(cursor)))
    }

    const rows = await this.db.query.mentions.findMany({
      where: and(...whereConditions),
      orderBy: [desc(schema.mentions.createdAt)],
      limit: limit + 1,
      with: {
        message: {
          with: {
            user: true,
            channel: true,
            conversation: true,
          },
        },
      },
    })

    const hasMore = rows.length > limit
    const items = rows.slice(0, limit)
    const nextCursor = hasMore
      ? items[items.length - 1].createdAt.toISOString()
      : null

    return {
      items,
      nextCursor,
      hasMore,
    }
  }
}
