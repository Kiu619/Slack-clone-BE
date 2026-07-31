import { z } from 'zod'

export const SaveItemSchema = z
  .object({
    type: z.enum(['message', 'attachment', 'reminder']),
    messageId: z.string().uuid().optional(),
    attachmentId: z.string().uuid().optional(),
    note: z.string().optional(),
    remindAt: z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'reminder') return !!data.note
      return data.messageId || data.attachmentId
    },
    {
      message:
        'Either messageId, attachmentId or note (for reminder) must be provided',
      path: ['messageId'],
    },
  )

export type SaveItemDto = z.infer<typeof SaveItemSchema>

export const UpdateLaterItemSchema = z.object({
  status: z.enum(['in_progress', 'completed', 'archived']).optional(),
  note: z.string().optional(),
  remindAt: z.string().datetime().nullable().optional(),
})

export type UpdateLaterItemDto = z.infer<typeof UpdateLaterItemSchema>

export const CheckLaterMessagesSchema = z
  .object({
    messageIds: z.array(z.string().uuid()),
  })
  .transform((data) => ({
    messageIds: [...new Set(data.messageIds)],
  }))
  .pipe(
    z.object({
      messageIds: z.array(z.string().uuid()).max(200),
    }),
  )

export type CheckLaterMessagesDto = z.infer<typeof CheckLaterMessagesSchema>
