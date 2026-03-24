import { z } from 'zod'

export const UpdateMemberStatusSchema = z.object({
  statusText: z.string().max(100).optional().nullable(),
  statusEmoji: z.string().optional().nullable(),
  statusExpiration: z.string().datetime().optional().nullable(),
  notificationsPausedUntil: z.string().datetime().optional().nullable(),
})

export type UpdateMemberStatusDto = z.infer<typeof UpdateMemberStatusSchema>
