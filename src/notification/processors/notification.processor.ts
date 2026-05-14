import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '../../database/database.module'
import { DRIZZLE } from '../../database/database.module'
import * as schema from '../../database/schema'
import { ChatBroadcastService } from '../../chat/chat-broadcast.service'

@Processor('notification')
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly broadcastService: ChatBroadcastService,
  ) {
    super()
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);
    switch (job.name) {
      case 'notify-channel':
        return this.handleNotifyChannel(job.data)
      default:
        this.logger.warn(`Unknown job name: ${job.name}`)
    }
  }

  private async handleNotifyChannel(data: {
    messageId: string
    senderId: string
    workspaceId: string
    channelId?: string
    conversationId?: string
    content: string
  }) {
    const {
      messageId,
      senderId,
      workspaceId,
      channelId,
      conversationId,
      content,
    } = data

    // 1. Parse mentions từ content
    const mentions = this.parseMentions(content)
    const directMentionUserIds = mentions
      .filter(
        (m): m is { type: string; id: string } => m.type === 'user' && !!m.id,
      )
      .map((m) => m.id)
    const hasHereMention = mentions.some((m) => m.type === 'here')
    const hasChannelMention = mentions.some((m) => m.type === 'channel')

    // 2. Lấy danh sách thành viên (trừ người gửi)
    let memberIds: string[] = []
    if (channelId) {
      const members = await this.db.query.channelMembers.findMany({
        where: eq(schema.channelMembers.channelId, channelId),
        columns: { userId: true },
      })
      memberIds = members.map((m) => m.userId).filter((id) => id !== senderId)
    } else if (conversationId) {
      const members = await this.db.query.conversationMembers.findMany({
        where: eq(schema.conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      })
      memberIds = members.map((m) => m.userId).filter((id) => id !== senderId)
    }

    if (memberIds.length === 0) return

    // 3. Lấy settings & overrides của tất cả members trong 1 query (Batch)
    const membersSettings = await this.db.query.workspaceMembers.findMany({
      where: and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        inArray(schema.workspaceMembers.userId, memberIds),
      ),
      with: {
        // Giả sử bạn đã định nghĩa relation này trong schema.ts
        // Nếu chưa, chúng ta sẽ query riêng hoặc dùng join
      },
    })

    // Tạm thời query overrides riêng vì relation có thể chưa được update hoàn toàn trong memory
    const overrides = await this.db.query.channelNotificationOverrides.findMany(
      {
        where: and(
          eq(schema.channelNotificationOverrides.workspaceId, workspaceId),
          inArray(schema.channelNotificationOverrides.userId, memberIds),
          channelId
            ? eq(schema.channelNotificationOverrides.channelId, channelId)
            : eq(
              schema.channelNotificationOverrides.conversationId,
              conversationId!,
            ),
        ),
      },
    )

    const overrideMap = new Map(overrides.map((o) => [o.userId, o]))

    // 4. Lọc những người cần notify
    const notificationsToInsert: any[] = []

    for (const member of membersSettings) {
      const userOverride = overrideMap.get(member.userId)

      const mentionType = this.getMentionTypeForUser(
        member.userId,
        directMentionUserIds,
        hasHereMention,
        hasChannelMention,
        !!conversationId,
      )

      const { shouldCreateRecord } = this.shouldNotify(
        member,
        userOverride,
        mentionType,
      )

      if (shouldCreateRecord) {
        notificationsToInsert.push({
          userId: member.userId,
          workspaceId,
          actorId: senderId,
          type: this.getNotificationType(mentionType),
          messageId,
          channelId,
          conversationId,
        })
      }
    }

    // 5. Batch Insert Notifications
    if (notificationsToInsert.length > 0) {
      const insertedNotifications = await this.db
        .insert(schema.notifications)
        .values(notificationsToInsert)
        .returning()

      this.logger.log(
        `Inserted ${notificationsToInsert.length} notifications for message ${messageId}`,
      )

      // 6. Realtime Push qua Socket.io
      for (const notif of insertedNotifications) {
        // Lấy thêm thông tin actor để frontend hiển thị (tên, avatar)
        const actor = await this.db.query.users.findFirst({
          where: eq(schema.users.id, senderId),
          columns: { name: true, avatar: true },
        })

        this.broadcastService.broadcastNotification(notif.userId, workspaceId, {
          ...notif,
          actor,
        })
      }
    }

    // 7. Lưu Mentions vào bảng mentions
    const mentionsToInsert = mentions.map((m) => ({
      messageId,
      workspaceId,
      mentionedUserId: m.type === 'user' ? m.id : null,
      type: m.type as 'user' | 'here' | 'channel',
    }))

    if (mentionsToInsert.length > 0) {
      await this.db.insert(schema.mentions).values(mentionsToInsert)
    }

    return { success: true, count: notificationsToInsert.length }
  }

  private parseMentions(content: string) {
    const mentions: { type: string; id?: string }[] = []

    // 1. Parse Tiptap HTML mentions: data-id="uuid"
    const tiptapMentionRegex = /data-id="([a-f0-9-]{36})"/g
    let match
    while ((match = tiptapMentionRegex.exec(content)) !== null) {
      if (match[1]) {
        mentions.push({ type: 'user', id: match[1] })
      }
    }

    // 2. Parse legacy/markdown user mentions: <@uuid>
    const userRegex = /<@([a-f0-9-]{36})>/g
    while ((match = userRegex.exec(content)) !== null) {
      if (match[1]) {
        // Tránh duplicate nếu đã parse từ Tiptap HTML
        if (!mentions.some(m => m.id === match![1])) {
          mentions.push({ type: 'user', id: match[1] })
        }
      }
    }

    // 3. Special mentions: <!here>, <!channel> hoặc data-id="here/channel"
    if (content.includes('<!here>') || content.includes('data-id="here"')) mentions.push({ type: 'here' })
    if (content.includes('<!channel>') || content.includes('data-id="channel"')) mentions.push({ type: 'channel' })

    return mentions
  }

  private getMentionTypeForUser(
    userId: string,
    directIds: string[],
    hasHere: boolean,
    hasChannel: boolean,
    isDm: boolean,
  ): 'direct' | 'here' | 'channel' | 'dm' | 'none' {
    if (isDm) return 'dm'
    if (directIds.includes(userId)) return 'direct'
    if (hasChannel) return 'channel'
    if (hasHere) return 'here'
    return 'none'
  }

  private shouldNotify(member: any, override: any, mentionType: string) {
    // Mute
    if (override?.muteChannel) return { shouldCreateRecord: false }
    if (override?.mutedUntil && new Date(override.mutedUntil) > new Date())
      return { shouldCreateRecord: false }

    const notifyFor =
      override?.notifyFor ?? member.notifyFor ?? 'mentions_and_dm'
    if (notifyFor === 'nothing') return { shouldCreateRecord: false }

    if (notifyFor === 'all_messages') return { shouldCreateRecord: true }

    // mentions_and_dm
    if (['direct', 'dm'].includes(mentionType))
      return { shouldCreateRecord: true }
    if (mentionType === 'here')
      return { shouldCreateRecord: member.notifyOnHereMention }
    if (mentionType === 'channel')
      return { shouldCreateRecord: member.notifyOnChannelMention }

    return { shouldCreateRecord: false }
  }

  private getNotificationType(mentionType: string): 'mention' | 'dm' | 'reply' {
    if (mentionType === 'dm') return 'dm'
    return 'mention' // Mặc định cho direct/here/channel trong ngữ cảnh này
  }
}
