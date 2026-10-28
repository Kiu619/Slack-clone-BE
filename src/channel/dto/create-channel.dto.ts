import { z } from 'zod'
import { getChannelNameError } from '../channel-slug.util'

export const CreateChannelSchema = z.object({
  name: z.string().superRefine((v, ctx) => {
    const message = getChannelNameError(v)
    if (message !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
      })
    }
  }),
  type: z.enum(['text', 'audio', 'video']).default('text'),
  isPrivate: z.boolean().default(false),
  description: z.string().max(250).optional(),
})

export type CreateChannelDto = z.infer<typeof CreateChannelSchema>
