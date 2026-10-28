import { z } from 'zod'

export const ToggleThreadMuteSchema = z.object({
  isMuted: z.boolean(),
})

export type ToggleThreadMuteDto = z.infer<typeof ToggleThreadMuteSchema>
