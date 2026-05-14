import { z } from 'zod'

export const RecentVisitSchema = z.object({
  kind: z.enum(['channel', 'dm']),
  id: z.string().min(1, 'Target id is required'),
})

export type RecentVisitDto = z.infer<typeof RecentVisitSchema>
