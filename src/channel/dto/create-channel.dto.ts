import { z } from 'zod'

export const CreateChannelSchema = z.object({
  name: z
    .string()
    .min(2, 'Channel name must be at least 2 characters')
    .max(80, 'Channel name must be at most 80 characters')
    .regex(
      /^[a-z0-9-_]+$/,
      'Channel name can only contain lowercase letters, numbers, hyphens and underscores',
    ),
  type: z.enum(['text', 'audio', 'video']).default('text'),
  isPrivate: z.boolean().default(false),
  description: z.string().max(250).optional(),
})

export type CreateChannelDto = z.infer<typeof CreateChannelSchema>
