import { z } from 'zod'

/**
 * DTO để tạo attachment sau khi upload file lên S3/Cloudinary
 */
export const CreateAttachmentSchema = z.object({
  messageId: z.uuid(' Message ID must be a UUID'),
  workspaceId: z.uuid(' Workspace ID must be a UUID'),
  channelId: z.uuid().optional().nullable(),
  conversationId: z.uuid().optional().nullable(),
  url: z.url(' URL is not valid').refine((value) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }, ' URL must use http/https protocol'),
  type: z.enum(['image', 'video', 'audio', 'file']),
  fileCategory: z
    .enum([
      'image',
      'video',
      'audio',
      'pdf',
      'spreadsheet',
      'presentation',
      'document',
      'archive',
      'code',
      'other',
    ])
    .default('other'),
  name: z.string().min(1, 'name không được để trống').max(255),
  size: z.number().int().nonnegative('size phải >= 0'),
  mimeType: z.string().optional().nullable(),
  width: z.number().int().positive().optional().nullable(),
  height: z.number().int().positive().optional().nullable(),
  duration: z.number().positive().optional().nullable(),
})

export type CreateAttachmentDto = z.infer<typeof CreateAttachmentSchema>

/**
 * DTO cho Search Attachments (All Files)
 */
export const SearchAttachmentsSchema = z.object({
  workspaceId: z.uuid(),
  scope: z.enum(['all', 'created_by_me', 'shared_with_me']).default('all'),
  categories: z.string().optional(), // Comma separated: "pdf,image"
  sort: z.enum(['recent_viewed', 'last_updated', 'newest']).default('newest'),
  userIds: z.string().optional(), // Comma separated user IDs
  channelIds: z.string().optional(), // Comma separated channel IDs
  conversationIds: z.string().optional(), // Comma separated DM IDs
  dateFrom: z.string().optional(), // ISO Date
  dateTo: z.string().optional(), // ISO Date
  name: z.string().optional(), // Search by name
  limit: z.coerce.number().int().default(20),
  offset: z.coerce.number().int().default(0),
})

export type SearchAttachmentsDto = z.infer<typeof SearchAttachmentsSchema>
