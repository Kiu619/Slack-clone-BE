import { z } from 'zod'

export const GetWeeklyHuddlesQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(20).optional().default(6),
})

export type GetWeeklyHuddlesQuery = z.infer<typeof GetWeeklyHuddlesQuerySchema>
