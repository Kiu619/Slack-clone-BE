import { z } from 'zod'

const customEmojiNameSchema = z
  .string()
  .trim()
  .min(1, 'Emoji name is required')
  .max(64, 'Emoji name is too long')
  .transform((value) => value.toLowerCase())
  .refine((value) => /^[a-z0-9_]+$/.test(value), {
    message:
      'Emoji name can only contain lowercase letters, numbers, and underscores',
  })

const imageUrlSchema = z
  .string()
  .trim()
  .min(1, 'Image URL is required')
  .url('Image URL must be valid')

export const CreateWorkspaceCustomEmojiSchema = z.object({
  name: customEmojiNameSchema,
  imageUrl: imageUrlSchema,
})

export type CreateWorkspaceCustomEmojiDto = z.infer<
  typeof CreateWorkspaceCustomEmojiSchema
>

export const CreateWorkspaceCustomEmojiAliasSchema = z
  .object({
    sourceEmojiId: z
      .string()
      .trim()
      .min(1, 'Source emoji is required')
      .optional(),
    sourceDefaultEmoji: z
      .string()
      .trim()
      .min(1, 'Source emoji is required')
      .optional(),
    alias: customEmojiNameSchema,
  })
  .refine((value) => Boolean(value.sourceEmojiId || value.sourceDefaultEmoji), {
    message: 'Source emoji is required',
    path: ['sourceEmojiId'],
  })

export type CreateWorkspaceCustomEmojiAliasDto = z.infer<
  typeof CreateWorkspaceCustomEmojiAliasSchema
>

export const WorkspaceCustomEmojisQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  sortBy: z.enum(['name', 'createdAt', 'createdBy']).optional(),
  sortDirection: z.enum(['asc', 'desc']).optional(),
  q: z.string().trim().optional(),
})

export type WorkspaceCustomEmojisQueryDto = z.infer<
  typeof WorkspaceCustomEmojisQuerySchema
>

export const UpdateWorkspaceEmojiOneClickSchema = z.object({
  slots: z.tuple([
    z.string().nullable(),
    z.string().nullable(),
    z.string().nullable(),
  ]),
})

export type UpdateWorkspaceEmojiOneClickDto = z.infer<
  typeof UpdateWorkspaceEmojiOneClickSchema
>
