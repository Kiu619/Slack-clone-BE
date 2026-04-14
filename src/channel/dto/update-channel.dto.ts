import { z } from 'zod'

const nameSchema = z
  .string()
  .min(2, 'Channel name must be at least 2 characters')
  .max(80, 'Channel name must be at most 80 characters')
  .regex(
    /^[a-z0-9-_]+$/,
    'Channel name can only contain lowercase letters, numbers, hyphens and underscores',
  )

export const UpdateChannelSchema = z
  .object({
    name: nameSchema.optional(),
    topic: z.string().max(500).nullable().optional(),
    description: z.string().max(250).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  })

export type UpdateChannelDto = z.infer<typeof UpdateChannelSchema>
