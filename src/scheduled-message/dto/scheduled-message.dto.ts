import { z } from 'zod'

export const CreateScheduledMessageSchema = z
  .object({
    content: z.string().max(40_000),
    channelId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
    parentId: z.string().uuid().optional(),
    alsoSendToChannel: z.boolean().optional(),
    /** ISO 8601 */
    scheduledAt: z.string().datetime(),
  })
  .refine(
    (d) =>
      (!!d.channelId && !d.conversationId) ||
      (!d.channelId && !!d.conversationId),
    { message: 'Cần đúng một trong hai: channelId hoặc conversationId' },
  )

export type CreateScheduledMessageDto = z.infer<
  typeof CreateScheduledMessageSchema
>

export const ListScheduledQuerySchema = z.object({
  status: z.enum(['pending', 'cancelled', 'all']).optional(),
})

export type ListScheduledQueryDto = z.infer<typeof ListScheduledQuerySchema>

export const UpdateScheduledMessageSchema = z.object({
  /** ISO 8601 */
  scheduledAt: z.string().datetime(),
})

export type UpdateScheduledMessageDto = z.infer<
  typeof UpdateScheduledMessageSchema
>
