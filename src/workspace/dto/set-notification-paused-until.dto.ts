import { z } from 'zod'

export const SetNotificationPausedUntilSchema = z.object({
  pausedUntil: z.string().datetime().nullable(),
  auto: z.boolean().optional().default(false),
})

export type SetNotificationPausedUntilDto = z.infer<
  typeof SetNotificationPausedUntilSchema
>
