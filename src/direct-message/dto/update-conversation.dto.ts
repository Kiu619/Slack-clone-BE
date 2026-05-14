import { z } from 'zod'

export const UpdateConversationSchema = z
  .object({
    topic: z.string().max(500).nullable().optional(),
    description: z.string().max(250).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  })

export type UpdateConversationDto = z.infer<typeof UpdateConversationSchema>
