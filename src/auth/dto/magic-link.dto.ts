import { z } from 'zod'

export const MagicLinkSchema = z.object({
  email: z.email('Invalid email address'),
})

export type MagicLinkDto = z.infer<typeof MagicLinkSchema>
