import { Inject, Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DRIZZLE } from '../database/database.module';
import type { DrizzleDB } from '../database/database.module';
import * as schema from '../database/schema';
import { and, desc, eq, lt, sql, gt, isNull, or } from 'drizzle-orm';
import { UpdateGlobalSettingsDto, UpdateChannelOverrideDto } from './dto/update-settings.dto';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectQueue('notification') private readonly notificationQueue: Queue,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  async enqueueNotificationJob(data: any) {
    try {
      await this.notificationQueue.add('notify-channel', data, {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: true,
      });
    } catch (error) {
      this.logger.error(`Failed to enqueue notification job: ${error.message}`);
    }
  }

  async getNotifications(userId: string, workspaceId: string, limit = 20, cursor?: string) {
    const whereConditions = [
      eq(schema.notifications.userId, userId),
      eq(schema.notifications.workspaceId, workspaceId),
    ];

    if (cursor) {
      whereConditions.push(lt(schema.notifications.createdAt, new Date(cursor)));
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
    });

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
      // Drizzle query inference might be ambiguous about 'one' vs 'many' relations
      const actor = row.actor;
      
      if (!actor || Array.isArray(actor)) {
        return { ...row, actor: null };
      }

      // Explicitly type the actor with its joined relations
      const actorWithMembers = actor as {
        id: string;
        name: string | null;
        avatar: string | null;
        workspaceMembers: {
          displayName: string | null;
          name: string | null;
          avatar: string | null;
        }[];
      };

      const workspaceMember = actorWithMembers.workspaceMembers?.[0];
      return {
        ...row,
        actor: {
          id: actorWithMembers.id,
          name: workspaceMember?.displayName || workspaceMember?.name || actorWithMembers.name,
          avatar: workspaceMember?.avatar || actorWithMembers.avatar,
        },
      };
    });
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null;

    return {
      items,
      nextCursor,
      hasMore,
    };
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
      );
    
    return { count: Number(result?.count || 0) };
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
      .returning();

    if (!updated) throw new NotFoundException('Notification not found');
    return updated;
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
      );
    
    return { success: true };
  }

  // ─── Settings Logic ───

  async updateGlobalSettings(userId: string, workspaceId: string, dto: UpdateGlobalSettingsDto) {
    const [updated] = await this.db
      .update(schema.workspaceMembers)
      .set(dto)
      .where(
        and(
          eq(schema.workspaceMembers.userId, userId),
          eq(schema.workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundException('Workspace member not found');
    return updated;
  }

  async updateChannelOverride(userId: string, workspaceId: string, dto: UpdateChannelOverrideDto) {
    if (!dto.channelId && !dto.conversationId) {
      throw new BadRequestException('Either channelId or conversationId must be provided');
    }

    const whereClause = and(
      eq(schema.channelNotificationOverrides.userId, userId),
      eq(schema.channelNotificationOverrides.workspaceId, workspaceId),
      dto.channelId 
        ? eq(schema.channelNotificationOverrides.channelId, dto.channelId)
        : eq(schema.channelNotificationOverrides.conversationId, dto.conversationId!),
    );

    const [existing] = await this.db
      .select()
      .from(schema.channelNotificationOverrides)
      .where(whereClause)
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(schema.channelNotificationOverrides)
        .set({
          ...dto,
          mutedUntil: dto.mutedUntil ? new Date(dto.mutedUntil) : undefined,
        })
        .where(eq(schema.channelNotificationOverrides.id, existing.id))
        .returning();
      return updated;
    } else {
      const [inserted] = await this.db
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
        .returning();
      return inserted;
    }
  }

  // ─── Unread Logic ───

  async getWorkspaceUnreadCounts(userId: string, workspaceId: string) {
    // 1. Get all channels the user is in
    const channelList = await this.db
      .select({
        id: schema.channels.id,
        lastReadAt: schema.channelMembers.lastReadAt,
      })
      .from(schema.channels)
      .innerJoin(
        schema.channelMembers,
        and(
          eq(schema.channelMembers.channelId, schema.channels.id),
          eq(schema.channelMembers.userId, userId),
        ),
      )
      .where(eq(schema.channels.workspaceId, workspaceId));

    // 2. Get all DM conversations the user is in
    const conversationList = await this.db
      .select({
        id: schema.directMessageConversations.id,
        lastReadAt: schema.conversationMembers.lastReadAt,
      })
      .from(schema.directMessageConversations)
      .innerJoin(
        schema.conversationMembers,
        and(
          eq(schema.conversationMembers.conversationId, schema.directMessageConversations.id),
          eq(schema.conversationMembers.userId, userId),
        ),
      )
      .where(eq(schema.directMessageConversations.workspaceId, workspaceId));

    // 3. Count unread messages for each channel
    const channelCounts = await Promise.all(
      channelList.map(async (ch) => {
        const [res] = await this.db
          .select({ count: sql<number>`count(*)` })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.channelId, ch.id),
              gt(schema.messages.createdAt, ch.lastReadAt),
              isNull(schema.messages.deletedAt),
            ),
          );
        return { id: ch.id, unreadCount: Number(res?.count || 0) };
      }),
    );

    // 4. Count unread messages for each DM
    const conversationCounts = await Promise.all(
      conversationList.map(async (conv) => {
        const [res] = await this.db
          .select({ count: sql<number>`count(*)` })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.conversationId, conv.id),
              gt(schema.messages.createdAt, conv.lastReadAt),
              isNull(schema.messages.deletedAt),
            ),
          );
        return { id: conv.id, unreadCount: Number(res?.count || 0) };
      }),
    );

    return {
      channels: channelCounts,
      conversations: conversationCounts,
    };
  }

  async markChannelAsRead(userId: string, channelId: string) {
    await this.db
      .update(schema.channelMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.userId, userId),
        ),
      );
    return { success: true };
  }

  async markConversationAsRead(userId: string, conversationId: string) {
    await this.db
      .update(schema.conversationMembers)
      .set({ lastReadAt: new Date() })
      .where(
        and(
          eq(schema.conversationMembers.conversationId, conversationId),
          eq(schema.conversationMembers.userId, userId),
        ),
      );
    return { success: true };
  }

  async getMentions(userId: string, workspaceId: string, limit = 20, cursor?: string) {
    const whereConditions = [
      eq(schema.mentions.mentionedUserId, userId),
      eq(schema.mentions.workspaceId, workspaceId),
    ];

    if (cursor) {
      whereConditions.push(lt(schema.mentions.createdAt, new Date(cursor)));
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
    });

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null;

    return {
      items,
      nextCursor,
      hasMore,
    };
  }
}
