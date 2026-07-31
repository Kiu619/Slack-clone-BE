import { randomUUID } from 'crypto'
import { relations, sql } from 'drizzle-orm'
import type { HuddleMessageSnapshot } from '../huddle/huddle.types'
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const channelTypeEnum = pgEnum('channel_type', [
  'text',
  'audio',
  'video',
])

export const huddleEntityTypeEnum = pgEnum('huddle_entity_type', [
  'channel',
  'dm',
])

export const huddleSessionStatusEnum = pgEnum('huddle_session_status', [
  'pending',
  'active',
  'ended',
])

/** Tài khoản: email + default hiển thị (OAuth) khi seed workspace_members */
export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatar: text('avatar'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
})

export const accounts = pgTable(
  'accounts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
  },
  (table) => [
    uniqueIndex('accounts_provider_account_unique').on(
      table.provider,
      table.providerAccountId,
    ),
    index('accounts_user_id_idx').on(table.userId),
  ],
)

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    inviteCode: text('invite_code').notNull(),
    imageUrl: text('image_url').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('workspaces_slug_unique').on(table.slug),
    uniqueIndex('workspaces_invite_code_unique').on(table.inviteCode),
  ],
)

// Junction table: workspace members (many-to-many users <-> workspaces)
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['member', 'admin', 'owner', 'primary_owner'] })
      .notNull()
      .default('member'),
    membershipStatus: text('membership_status', {
      enum: ['active', 'deactivated'],
    })
      .notNull()
      .default('active'),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
    /** Profile trong workspace (Slack-style) */
    email: text('email'), // Lưu email để hiển thị profile nhanh hơn không cần join users
    name: text('name'),
    displayName: text('display_name'),
    avatar: text('avatar'),
    isAway: boolean('is_away').notNull().default(false),
    namePronunciation: text('name_pronunciation'),
    phone: text('phone'),
    description: text('description'),
    timeZone: text('time_zone'),
    statusText: text('status_text'),
    statusEmoji: text('status_emoji'),
    statusExpiration: timestamp('status_expiration'),
    notificationsPausedUntil: timestamp('notifications_paused_until'),
    theme: text('theme'),

    // ─── Global notification preferences ───
    notifyFor: text('notify_for', {
      enum: ['all_messages', 'mentions_and_dm', 'nothing'],
    })
      .notNull()
      .default('mentions_and_dm'),
    notifyOnHereMention: boolean('notify_on_here_mention')
      .notNull()
      .default(true),
    notifyOnChannelMention: boolean('notify_on_channel_mention')
      .notNull()
      .default(true),

    // ─── Do Not Disturb ───
    dndEnabled: boolean('dnd_enabled').notNull().default(false),
    /** 0-23, ví dụ: 22 = 10pm */
    dndStartHour: integer('dnd_start_hour'),
    dndEndHour: integer('dnd_end_hour'),
    dndTimezone: text('dnd_timezone'),
  },
  (table) => [
    uniqueIndex('workspace_members_unique').on(table.workspaceId, table.userId),
    index('workspace_members_workspace_idx').on(table.workspaceId),
    index('workspace_members_user_idx').on(table.userId),
  ],
)

export const workspacePermissions = pgTable(
  'workspace_permissions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key').notNull(),
    memberAllowed: boolean('member_allowed').notNull().default(false),
    adminAllowed: boolean('admin_allowed').notNull().default(false),
    ownerAllowed: boolean('owner_allowed').notNull().default(false),
    primaryOwnerAllowed: boolean('primary_owner_allowed')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('workspace_permissions_workspace_permission_unique').on(
      table.workspaceId,
      table.permissionKey,
    ),
    index('workspace_permissions_workspace_idx').on(table.workspaceId),
  ],
)

export const workspaceCustomEmojis = pgTable(
  'workspace_custom_emojis',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    imageUrl: text('image_url').notNull(),
    aliasOfId: text('alias_of_id'),
    sourceDefaultEmoji: text('source_default_emoji'),
    createdById: text('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('workspace_custom_emojis_workspace_name_unique').on(
      table.workspaceId,
      table.name,
    ),
    index('workspace_custom_emojis_workspace_idx').on(table.workspaceId),
    index('workspace_custom_emojis_alias_of_idx').on(table.aliasOfId),
    index('workspace_custom_emojis_source_default_emoji_idx').on(
      table.sourceDefaultEmoji,
    ),
  ],
)

export const workspaceEmojiSettings = pgTable(
  'workspace_emoji_settings',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slot1Emoji: text('slot_1_emoji'),
    slot2Emoji: text('slot_2_emoji'),
    slot3Emoji: text('slot_3_emoji'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('workspace_emoji_settings_workspace_unique').on(
      table.workspaceId,
    ),
  ],
)

export const channels = pgTable(
  'channels',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    type: channelTypeEnum('type').notNull().default('text'),
    isPrivate: boolean('is_private').notNull().default(false),
    /** Kênh mặc định workspace (vd. #general) — không đổi tên qua API thường user */
    isDefaultChannel: boolean('is_default_channel').notNull().default(false),
    topic: text('topic'),
    description: text('description'),
    postingSettings: jsonb('posting_settings')
      .$type<{
        mode: 'everyone' | 'admin_only' | 'admins_plus_specific_people'
        allowThreads: boolean
        allowMentions: boolean
        specificUserIds: string[]
      } | null>()
      .default(null),
    createdById: text('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // slug unique per workspace
    uniqueIndex('channels_workspace_slug_unique').on(
      table.workspaceId,
      table.slug,
    ),
    index('channels_workspace_idx').on(table.workspaceId),
  ],
)

/** Membership trong channel (public + private): người tạo = owner; người được thêm sau = member. */
export const channelMembers = pgTable(
  'channel_members',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['member', 'admin', 'owner', 'primary_owner'] })
      .notNull()
      .default('member'),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
    lastReadAt: timestamp('last_read_at').defaultNow().notNull(),
    /** Star cá nhân (sidebar); null = chưa star */
    starredAt: timestamp('starred_at'),
  },
  (table) => [
    uniqueIndex('channel_members_unique').on(table.channelId, table.userId),
    index('channel_members_channel_idx').on(table.channelId),
    index('channel_members_user_idx').on(table.userId),
  ],
)

// ─── Direct messages ─────────────────────────────────────────────────────────────────
export const directMessageConversations = pgTable(
  'dm_conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Phân biệt DM 1-1 và Group DM (max 9 người) */
    isGroup: boolean('is_group').notNull().default(false),
    lastMessageAt: timestamp('last_message_at'),
    lastMessageContent: text('last_message_content'),
    lastMessageUserId: text('last_message_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastMessageId: text('last_message_id'),
    topic: text('topic'),
    description: text('description'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('dm_conversations_workspace_idx').on(table.workspaceId)],
)

/** Thành viên trong cuộc hội thoại DM */
export const conversationMembers = pgTable(
  'conversation_members',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => directMessageConversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
    lastReadAt: timestamp('last_read_at').defaultNow().notNull(),
    /** Star cá nhân (sidebar); null = chưa star */
    starredAt: timestamp('starred_at'),
  },
  (table) => [
    uniqueIndex('conversation_members_unique').on(
      table.conversationId,
      table.userId,
    ),
    index('conversation_members_conversation_idx').on(table.conversationId),
    index('conversation_members_user_idx').on(table.userId),
  ],
)

export const huddleSessions = pgTable(
  'huddle_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    entityType: huddleEntityTypeEnum('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    /** Active session marker used to guarantee only one non-ended session per entity. */
    entityActiveKey: text('entity_active_key'),
    roomName: text('room_name').notNull(),
    status: huddleSessionStatusEnum('status').notNull().default('pending'),
    startedById: text('started_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    endedAt: timestamp('ended_at'),
    lastActivityAt: timestamp('last_activity_at').defaultNow().notNull(),
    topic: text('topic'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('huddle_sessions_entity_active_key_unique').on(
      table.entityActiveKey,
    ),
    index('huddle_sessions_workspace_idx').on(table.workspaceId),
    index('huddle_sessions_entity_idx').on(
      table.workspaceId,
      table.entityType,
      table.entityId,
      table.startedAt,
    ),
    index('huddle_sessions_room_name_idx').on(table.roomName),
  ],
)

export const huddleParticipants = pgTable(
  'huddle_participants',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    sessionId: text('session_id')
      .notNull()
      .references(() => huddleSessions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
    leftAt: timestamp('left_at'),
    isMuted: boolean('is_muted').notNull().default(false),
    isCameraOn: boolean('is_camera_on').notNull().default(false),
    isScreenSharing: boolean('is_screen_sharing').notNull().default(false),
    isSpeaking: boolean('is_speaking').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('huddle_participants_session_user_unique').on(
      table.sessionId,
      table.userId,
    ),
    index('huddle_participants_session_idx').on(table.sessionId),
    index('huddle_participants_user_idx').on(table.userId),
  ],
)

/** Channel/DM gần đây trong sidebar toolbar (tối đa 10 / user / workspace) */
export const workspaceSidebarRecents = pgTable(
  'workspace_sidebar_recents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['channel', 'dm'] }).notNull(),
    targetId: text('target_id').notNull(),
    visitedAt: timestamp('visited_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('workspace_sidebar_recents_user_ws_kind_target').on(
      table.userId,
      table.workspaceId,
      table.kind,
      table.targetId,
    ),
    index('workspace_sidebar_recents_user_ws_visited_idx').on(
      table.userId,
      table.workspaceId,
      table.visitedAt,
    ),
  ],
)

// ─── Messages ─────────────────────────────────────────────────────────────────

export const messageTypeEnum = pgEnum('message_type', [
  'text',
  'system',
  'timeline',
  'huddle',
])

export const savedItemStatusEnum = pgEnum('saved_item_status', [
  'in_progress',
  'completed',
  'archived',
])

export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    // Nullable — chỉ một trong hai được set
    channelId: text('channel_id').references(() => channels.id, {
      onDelete: 'cascade',
    }),
    conversationId: text('conversation_id').references(
      () => directMessageConversations.id,
      { onDelete: 'cascade' },
    ),

    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    type: messageTypeEnum('type').notNull().default('text'),
    parentId: text('parent_id'),
    huddleSessionId: text('huddle_session_id'),
    huddleSnapshot: jsonb('huddle_snapshot').$type<HuddleMessageSnapshot | null>(),
    alsoSendToChannel: boolean('also_send_to_channel').notNull().default(false),
    replyCount: integer('reply_count').notNull().default(0),
    lastReplyAt: timestamp('last_reply_at'),
    workspaceId: text('workspace_id').references(() => workspaces.id, {
      onDelete: 'cascade',
    }),
    editedAt: timestamp('edited_at'),
    deletedAt: timestamp('deleted_at'),
    isPinned: boolean('is_pinned').notNull().default(false),
    /** false = tin do server tạo (topic/description/merge), không cho PATCH nội dung */
    allowEdit: boolean('allow_edit').notNull().default(true),
    /** Snapshot tin gốc khi message là forward (JSON) */
    forwardSnapshot: jsonb('forward_snapshot').$type<Record<
      string,
      unknown
    > | null>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('messages_user_idx').on(table.userId),
    index('messages_channel_created_id_idx').on(
      table.channelId,
      table.createdAt,
      table.id,
    ),
    index('messages_conversation_created_id_idx').on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
    index('messages_parent_created_id_idx').on(
      table.parentId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex('messages_huddle_session_unique').on(table.huddleSessionId),
    index('messages_workspace_idx').on(table.workspaceId),
  ],
)

export const threadSubscriptions = pgTable(
  'thread_subscriptions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentMessageId: text('parent_message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at').defaultNow().notNull(),
    isMuted: boolean('is_muted').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('thread_subscriptions_user_parent_unique').on(
      table.userId,
      table.parentMessageId,
    ),
    index('thread_subscriptions_user_workspace_idx').on(
      table.userId,
      table.workspaceId,
    ),
    index('thread_subscriptions_parent_idx').on(table.parentMessageId),
  ],
)

export const reactions = pgTable(
  'reactions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * emoji: lưu unicode emoji string (ví dụ: "👍", "❤️", "😂")
     * Không cần bảng emoji riêng — string đủ rồi
     */
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // Mỗi user chỉ react 1 lần với mỗi emoji trên 1 message
    uniqueIndex('reactions_unique').on(
      table.messageId,
      table.userId,
      table.emoji,
    ),
    index('reactions_message_idx').on(table.messageId),
    index('reactions_user_idx').on(table.userId),
  ],
)

export const attachments = pgTable(
  'attachments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),

    // --- Các trường bổ sung cho All Files Search ---
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').references(() => channels.id, {
      onDelete: 'set null',
    }),
    conversationId: text('conversation_id').references(
      () => directMessageConversations.id,
      { onDelete: 'set null' },
    ),
    /**
     * Phân loại file để filter nhanh:
     * 'image' | 'video' | 'audio' | 'pdf' | 'spreadsheet' | 'presentation' | 'document' | 'archive' | 'code' | 'other'
     */
    fileCategory: text('file_category').notNull().default('other'),
    // ----------------------------------------------

    url: text('url').notNull(),
    /** 'image' | 'video' | 'audio' | 'file' */
    type: text('type').notNull().default('file'),
    name: text('name').notNull(),
    /** size tính bằng bytes */
    size: integer('size').notNull().default(0),
    /** MIME type (e.g., "image/png", "application/pdf") */
    mimeType: text('mime_type'),
    /** Width (px) cho image/video */
    width: integer('width'),
    /** Height (px) cho image/video */
    height: integer('height'),
    /** Duration (giây) cho video/audio — dùng double vì Cloudinary trả về số thập phân */
    duration: doublePrecision('duration'),
    previewImageUrl: text('preview_image_url'),
    previewStatus: text('preview_status', {
      enum: ['pending', 'ready', 'failed'],
    }),
    previewUpdatedAt: timestamp('preview_updated_at'),
    previewErrorCode: text('preview_error_code'),
    /**
     * `message_body` — file user gửi / thêm khi sửa tin;
     * `forward_quote` — bản copy từ tin được forward (dùng khi mixed forward chỉ mang body).
     */
    originScope: text('origin_scope').notNull().default('message_body'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('attachments_message_idx').on(table.messageId),
    index('attachments_workspace_category_idx').on(
      table.workspaceId,
      table.fileCategory,
    ),
    index('attachments_user_idx').on(table.userId),
    index('attachments_channel_created_id_idx').on(
      table.channelId,
      table.createdAt,
      table.id,
    ),
    index('attachments_conversation_created_id_idx').on(
      table.conversationId,
      table.createdAt,
      table.id,
    ),
  ],
)

/** Lịch sử xem file của User (cho tính năng Recently Viewed) */
export const userFileInteractions = pgTable(
  'user_file_interactions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    attachmentId: text('attachment_id')
      .notNull()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    lastViewedAt: timestamp('last_viewed_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('user_file_interaction_unique').on(
      table.userId,
      table.attachmentId,
    ),
    index('user_file_interaction_user_workspace_idx').on(
      table.userId,
      table.workspaceId,
    ),
    index('user_file_interaction_last_viewed_idx').on(table.lastViewedAt),
  ],
)

/** Folder trong channel hoặc DM conversation (tab Folders) — tên unique trong phạm vi channel/DM */
export const channelFolders = pgTable(
  'channel_folders',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    channelId: text('channel_id').references(() => channels.id, {
      onDelete: 'cascade',
    }),
    conversationId: text('conversation_id').references(
      () => directMessageConversations.id,
      { onDelete: 'cascade' },
    ),
    name: text('name').notNull(),
    createdById: text('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('channel_folders_channel_name_unique').on(
      table.channelId,
      table.name,
    ),
    uniqueIndex('channel_folders_conversation_name_unique').on(
      table.conversationId,
      table.name,
    ),
    index('channel_folders_channel_idx').on(table.channelId),
    index('channel_folders_conversation_idx').on(table.conversationId),
  ],
)

/** Attachment được gắn vào folder (cùng channel với message của attachment) */
export const folderAttachments = pgTable(
  'folder_attachments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    folderId: text('folder_id')
      .notNull()
      .references(() => channelFolders.id, { onDelete: 'cascade' }),
    attachmentId: text('attachment_id')
      .notNull()
      .references(() => attachments.id, { onDelete: 'cascade' }),
    addedById: text('added_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    addedAt: timestamp('added_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('folder_attachments_folder_attachment_unique').on(
      table.folderId,
      table.attachmentId,
    ),
    index('folder_attachments_folder_idx').on(table.folderId),
    index('folder_attachments_attachment_idx').on(table.attachmentId),
  ],
)

/** Draft composer (HTML) đồng bộ đa thiết bị — `context_key` trùng quy ước FE */
export const messageDrafts = pgTable(
  'message_drafts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contextKey: text('context_key').notNull(),
    content: text('content').notNull().default(''),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('message_drafts_user_context_key_unique').on(
      table.userId,
      table.contextKey,
    ),
    index('message_drafts_user_workspace_idx').on(
      table.userId,
      table.workspaceId,
    ),
  ],
)

export const messageDraftsRelations = relations(messageDrafts, ({ one }) => ({
  user: one(users, {
    fields: [messageDrafts.userId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [messageDrafts.workspaceId],
    references: [workspaces.id],
  }),
}))

export const scheduledMessageStatusEnum = pgEnum('scheduled_message_status', [
  'pending',
  'sent',
  'cancelled',
])

/** Tin nhắn lên lịch gửi — BullMQ dispatch tại `scheduled_at` */
export const scheduledMessages = pgTable(
  'scheduled_messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').references(() => channels.id, {
      onDelete: 'cascade',
    }),
    conversationId: text('conversation_id').references(
      () => directMessageConversations.id,
      { onDelete: 'cascade' },
    ),
    parentId: text('parent_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    content: text('content').notNull(),
    alsoSendToChannel: boolean('also_send_to_channel').notNull().default(false),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    status: scheduledMessageStatusEnum('status').notNull().default('pending'),
    sentMessageId: text('sent_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('scheduled_messages_user_workspace_idx').on(
      table.userId,
      table.workspaceId,
    ),
    index('scheduled_messages_status_scheduled_at_idx').on(
      table.status,
      table.scheduledAt,
    ),
  ],
)

export const savedItems = pgTable(
  'saved_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** Loại item: lưu tin nhắn hay lưu file cụ thể */
    type: text('type', {
      enum: ['message', 'attachment', 'reminder'],
    }).notNull(),

    // Một trong hai cái này sẽ có giá trị (hoặc không có nếu là reminder)
    messageId: text('message_id').references(() => messages.id, {
      onDelete: 'cascade',
    }),
    attachmentId: text('attachment_id').references(() => attachments.id, {
      onDelete: 'cascade',
    }),

    /** Ghi chú cá nhân của user cho mục này */
    note: text('note'),
    /** Thời điểm nhắc nhở */
    remindAt: timestamp('remind_at'),
    status: savedItemStatusEnum('status').notNull().default('in_progress'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('saved_items_user_message_idx').on(table.userId, table.messageId),
    index('saved_items_user_attachment_idx').on(
      table.userId,
      table.attachmentId,
    ),
    index('saved_items_user_workspace_status_idx').on(
      table.userId,
      table.workspaceId,
      table.status,
    ),
    index('saved_items_user_workspace_status_remind_at_idx').on(
      table.userId,
      table.workspaceId,
      table.status,
      table.remindAt,
    ),
    index('saved_items_later_check_message_idx').on(
      table.userId,
      table.workspaceId,
      table.status,
      table.type,
      table.messageId,
    ),
    index('saved_items_later_check_attachment_idx').on(
      table.userId,
      table.workspaceId,
      table.status,
      table.type,
      table.attachmentId,
    ),
  ],
)

// ─── Channel / DM notification overrides ──────────────────────────────────────

export const channelNotificationOverrides = pgTable(
  'channel_notification_overrides',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    // Một trong hai — cover cả channel lẫn DM trong cùng một bảng
    channelId: text('channel_id').references(() => channels.id, {
      onDelete: 'cascade',
    }),
    conversationId: text('conversation_id').references(
      () => directMessageConversations.id,
      { onDelete: 'cascade' },
    ),

    muteChannel: boolean('mute_channel').notNull().default(false),
    /** null = kế thừa từ workspace_members.notifyFor */
    notifyFor: text('notify_for', {
      enum: ['all_messages', 'mentions_and_dm', 'nothing'],
    }),
    /** Mute tạm thời đến thời điểm này */
    mutedUntil: timestamp('muted_until'),
  },
  (table) => [
    uniqueIndex('channel_notif_override_channel_unique').on(
      table.userId,
      table.channelId,
    ),
    uniqueIndex('channel_notif_override_conv_unique').on(
      table.userId,
      table.conversationId,
    ),
    index('channel_notif_override_user_idx').on(table.userId),
  ],
)

// ─── Mentions ─────────────────────────────────────────────────────────────────

export const mentions = pgTable(
  'mentions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    /** null khi type = 'here' | 'channel' | 'everyone' */
    mentionedUserId: text('mentioned_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),

    /** Lưu dạng <@userId>, <!here>, <!channel> trong message.content */
    type: text('type', {
      enum: ['user', 'here', 'channel'],
    }).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('mentions_mentioned_user_idx').on(table.mentionedUserId),
    index('mentions_message_idx').on(table.messageId),
    index('mentions_workspace_idx').on(table.workspaceId),
  ],
)

// ─── Notifications ────────────────────────────────────────────────────────────

export const notificationTypeEnum = pgEnum('notification_type', [
  'mention', // @mention trực tiếp
  'post', // bài đăng/channel message thường
  'reply', // reply vào thread đang subscribe
  'reaction', // react vào message của mình
  'channel_invite', // được thêm vào channel
])

export const notifications = pgTable(
  'notifications',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    type: notificationTypeEnum('type').notNull(),

    /** Đủ context để render notification item mà không cần nhiều join */
    messageId: text('message_id').references(() => messages.id, {
      onDelete: 'cascade',
    }),
    channelId: text('channel_id').references(() => channels.id, {
      onDelete: 'set null',
    }),
    conversationId: text('conversation_id').references(
      () => directMessageConversations.id,
      { onDelete: 'set null' },
    ),
    /** Ai trigger notification này */
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('notifications_user_workspace_created_idx').on(
      table.userId,
      table.workspaceId,
      table.createdAt,
    ),
    index('notifications_unread_idx')
      .on(table.userId, table.workspaceId)
      .where(sql`${table.isRead} = false`),
  ],
)

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  workspaceMembers: many(workspaceMembers),
  conversationMemberships: many(conversationMembers),
}))

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}))

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  // removed: channels, dmConversations — no call-site, breaks cycle
}))

export const workspaceMembersRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceMembers.workspaceId],
      references: [workspaces.id],
    }),
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
  }),
)

export const channelsRelations = relations(channels, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [channels.workspaceId],
    references: [workspaces.id],
  }),
  createdBy: one(users, {
    fields: [channels.createdById],
    references: [users.id],
  }),
  members: many(channelMembers),
  folders: many(channelFolders),
}))

export const channelMembersRelations = relations(channelMembers, ({ one }) => ({
  channel: one(channels, {
    fields: [channelMembers.channelId],
    references: [channels.id],
  }),
  user: one(users, {
    fields: [channelMembers.userId],
    references: [users.id],
  }),
}))

export const directMessageConversationsRelations = relations(
  directMessageConversations,
  ({ one, many }) => ({
    workspace: one(workspaces, {
      fields: [directMessageConversations.workspaceId],
      references: [workspaces.id],
    }),
    members: many(conversationMembers),
    folders: many(channelFolders),
    // removed: messages — no call-site, breaks cycle
  }),
)

export const conversationMembersRelations = relations(
  conversationMembers,
  ({ one }) => ({
    conversation: one(directMessageConversations, {
      fields: [conversationMembers.conversationId],
      references: [directMessageConversations.id],
    }),
    user: one(users, {
      fields: [conversationMembers.userId],
      references: [users.id],
    }),
  }),
)

export const messagesRelations = relations(messages, ({ one, many }) => ({
  channel: one(channels, {
    fields: [messages.channelId],
    references: [channels.id],
  }),
  conversation: one(directMessageConversations, {
    fields: [messages.conversationId],
    references: [directMessageConversations.id],
  }),
  user: one(users, {
    fields: [messages.userId],
    references: [users.id],
  }),
  parent: one(messages, {
    fields: [messages.parentId],
    references: [messages.id],
    relationName: 'thread',
  }),
  replies: many(messages, { relationName: 'thread' }),
  reactions: many(reactions),
  attachments: many(attachments),
  threadSubscriptions: many(threadSubscriptions),
  mentions: many(mentions),
  // removed: notifications — no call-site, breaks cycle
}))

export const mentionsRelations = relations(mentions, ({ one }) => ({
  message: one(messages, {
    fields: [mentions.messageId],
    references: [messages.id],
  }),
  workspace: one(workspaces, {
    fields: [mentions.workspaceId],
    references: [workspaces.id],
  }),
  mentionedUser: one(users, {
    fields: [mentions.mentionedUserId],
    references: [users.id],
  }),
}))

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [notifications.workspaceId],
    references: [workspaces.id],
  }),
  message: one(messages, {
    fields: [notifications.messageId],
    references: [messages.id],
  }),
  channel: one(channels, {
    fields: [notifications.channelId],
    references: [channels.id],
  }),
  conversation: one(directMessageConversations, {
    fields: [notifications.conversationId],
    references: [directMessageConversations.id],
  }),
  actor: one(users, {
    fields: [notifications.actorId],
    references: [users.id],
  }),
}))

export const channelNotificationOverridesRelations = relations(
  channelNotificationOverrides,
  ({ one }) => ({
    user: one(users, {
      fields: [channelNotificationOverrides.userId],
      references: [users.id],
    }),
    workspace: one(workspaces, {
      fields: [channelNotificationOverrides.workspaceId],
      references: [workspaces.id],
    }),
    channel: one(channels, {
      fields: [channelNotificationOverrides.channelId],
      references: [channels.id],
    }),
    conversation: one(directMessageConversations, {
      fields: [channelNotificationOverrides.conversationId],
      references: [directMessageConversations.id],
    }),
  }),
)

export const threadSubscriptionsRelations = relations(
  threadSubscriptions,
  ({ one }) => ({
    user: one(users, {
      fields: [threadSubscriptions.userId],
      references: [users.id],
    }),
    parentMessage: one(messages, {
      fields: [threadSubscriptions.parentMessageId],
      references: [messages.id],
    }),
    workspace: one(workspaces, {
      fields: [threadSubscriptions.workspaceId],
      references: [workspaces.id],
    }),
  }),
)

export const reactionsRelations = relations(reactions, ({ one }) => ({
  message: one(messages, {
    fields: [reactions.messageId],
    references: [messages.id],
  }),
  user: one(users, {
    fields: [reactions.userId],
    references: [users.id],
  }),
}))

export const attachmentsRelations = relations(attachments, ({ one, many }) => ({
  message: one(messages, {
    fields: [attachments.messageId],
    references: [messages.id],
  }),
  workspace: one(workspaces, {
    fields: [attachments.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [attachments.userId],
    references: [users.id],
  }),
  channel: one(channels, {
    fields: [attachments.channelId],
    references: [channels.id],
  }),
  conversation: one(directMessageConversations, {
    fields: [attachments.conversationId],
    references: [directMessageConversations.id],
  }),
  folderLinks: many(folderAttachments),
  interactions: many(userFileInteractions),
}))

export const userFileInteractionsRelations = relations(
  userFileInteractions,
  ({ one }) => ({
    user: one(users, {
      fields: [userFileInteractions.userId],
      references: [users.id],
    }),
    attachment: one(attachments, {
      fields: [userFileInteractions.attachmentId],
      references: [attachments.id],
    }),
    workspace: one(workspaces, {
      fields: [userFileInteractions.workspaceId],
      references: [workspaces.id],
    }),
  }),
)

export const channelFoldersRelations = relations(
  channelFolders,
  ({ one, many }) => ({
    channel: one(channels, {
      fields: [channelFolders.channelId],
      references: [channels.id],
    }),
    conversation: one(directMessageConversations, {
      fields: [channelFolders.conversationId],
      references: [directMessageConversations.id],
    }),
    createdBy: one(users, {
      fields: [channelFolders.createdById],
      references: [users.id],
    }),
    folderAttachments: many(folderAttachments),
  }),
)

export const folderAttachmentsRelations = relations(
  folderAttachments,
  ({ one }) => ({
    folder: one(channelFolders, {
      fields: [folderAttachments.folderId],
      references: [channelFolders.id],
    }),
    attachment: one(attachments, {
      fields: [folderAttachments.attachmentId],
      references: [attachments.id],
    }),
    addedBy: one(users, {
      fields: [folderAttachments.addedById],
      references: [users.id],
    }),
  }),
)

export const savedItemsRelations = relations(savedItems, ({ one }) => ({
  user: one(users, {
    fields: [savedItems.userId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [savedItems.workspaceId],
    references: [workspaces.id],
  }),
  message: one(messages, {
    fields: [savedItems.messageId],
    references: [messages.id],
  }),
  attachment: one(attachments, {
    fields: [savedItems.attachmentId],
    references: [attachments.id],
  }),
}))

// ─── Types ────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Account = typeof accounts.$inferSelect
export type NewAccount = typeof accounts.$inferInsert
export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type WorkspaceMember = typeof workspaceMembers.$inferSelect
export type WorkspacePermission = typeof workspacePermissions.$inferSelect
export type Channel = typeof channels.$inferSelect
export type NewChannel = typeof channels.$inferInsert
export type ChannelMember = typeof channelMembers.$inferSelect
export type DirectMessageConversation =
  typeof directMessageConversations.$inferSelect
export type NewDirectMessageConversation =
  typeof directMessageConversations.$inferInsert
export type ConversationMember = typeof conversationMembers.$inferSelect
export type NewConversationMember = typeof conversationMembers.$inferInsert
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type Reaction = typeof reactions.$inferSelect
export type NewReaction = typeof reactions.$inferInsert
export type Attachment = typeof attachments.$inferSelect
export type NewAttachment = typeof attachments.$inferInsert
export type UserFileInteraction = typeof userFileInteractions.$inferSelect
export type NewUserFileInteraction = typeof userFileInteractions.$inferInsert
export type ChannelFolder = typeof channelFolders.$inferSelect
export type NewChannelFolder = typeof channelFolders.$inferInsert
export type FolderAttachment = typeof folderAttachments.$inferSelect
export type NewFolderAttachment = typeof folderAttachments.$inferInsert

export type SavedItem = typeof savedItems.$inferSelect
export type NewSavedItem = typeof savedItems.$inferInsert

export type MessageDraft = typeof messageDrafts.$inferSelect
export type NewMessageDraft = typeof messageDrafts.$inferInsert

export type ScheduledMessage = typeof scheduledMessages.$inferSelect
export type NewScheduledMessage = typeof scheduledMessages.$inferInsert

export type ThreadSubscription = typeof threadSubscriptions.$inferSelect

export type NewThreadSubscription = typeof threadSubscriptions.$inferInsert

export type Mention = typeof mentions.$inferSelect
export type NewMention = typeof mentions.$inferInsert
export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
export type ChannelNotificationOverride =
  typeof channelNotificationOverrides.$inferSelect
export type NewChannelNotificationOverride =
  typeof channelNotificationOverrides.$inferInsert
