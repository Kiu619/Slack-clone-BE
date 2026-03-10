import { randomUUID } from 'crypto'
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  boolean,
  integer,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

export const channelTypeEnum = pgEnum('channel_type', [
  'text',
  'audio',
  'video',
])

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatar: text('avatar'),
  isAway: boolean('is_away').notNull().default(false),
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
    slug: text('slug').notNull().unique(),
    inviteCode: text('invite_code').notNull().unique(),
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
    role: text('role', { enum: ['owner', 'admin', 'member'] })
      .notNull()
      .default('member'),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('workspace_members_unique').on(table.workspaceId, table.userId),
    index('workspace_members_workspace_idx').on(table.workspaceId),
    index('workspace_members_user_idx').on(table.userId),
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
    description: text('description'),
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

// Junction table: channel members (for private channels)
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
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('channel_members_unique').on(table.channelId, table.userId),
    index('channel_members_channel_idx').on(table.channelId),
    index('channel_members_user_idx').on(table.userId),
  ],
)

// ─── Messages ─────────────────────────────────────────────────────────────────

export const messageTypeEnum = pgEnum('message_type', ['text', 'system'])

export const messages = pgTable(
  'messages',
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
    content: text('content').notNull(),
    type: messageTypeEnum('type').notNull().default('text'),
    /**
     * parentId: nếu không null → đây là reply trong thread
     * Self-reference (messages.id → messages.id)
     */
    parentId: text('parent_id'),
    /** editedAt: timestamp khi message bị chỉnh sửa lần cuối */
    editedAt: timestamp('edited_at'),
    /** deletedAt: soft delete — không xóa khỏi DB, chỉ ẩn nội dung */
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('messages_channel_idx').on(table.channelId),
    index('messages_user_idx').on(table.userId),
    index('messages_parent_idx').on(table.parentId),
    // Index cho cursor pagination: channelId + createdAt DESC
    index('messages_channel_created_idx').on(table.channelId, table.createdAt),
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
    uniqueIndex('reactions_unique').on(table.messageId, table.userId, table.emoji),
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
    /** Duration (giây) cho video/audio */
    duration: integer('duration'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('attachments_message_idx').on(table.messageId)],
)

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  workspaceMembers: many(workspaceMembers),
}))

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}))

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  channels: many(channels),
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

export const messagesRelations = relations(messages, ({ one, many }) => ({
  channel: one(channels, {
    fields: [messages.channelId],
    references: [channels.id],
  }),
  user: one(users, {
    fields: [messages.userId],
    references: [users.id],
  }),
  // Self-reference cho thread replies
  parent: one(messages, {
    fields: [messages.parentId],
    references: [messages.id],
    relationName: 'thread',
  }),
  replies: many(messages, { relationName: 'thread' }),
  reactions: many(reactions),
  attachments: many(attachments),
}))

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

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  message: one(messages, {
    fields: [attachments.messageId],
    references: [messages.id],
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
export type Channel = typeof channels.$inferSelect
export type NewChannel = typeof channels.$inferInsert
export type ChannelMember = typeof channelMembers.$inferSelect
export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type Reaction = typeof reactions.$inferSelect
export type NewReaction = typeof reactions.$inferInsert
export type Attachment = typeof attachments.$inferSelect
export type NewAttachment = typeof attachments.$inferInsert
