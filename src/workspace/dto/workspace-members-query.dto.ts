import { z } from 'zod'

export const WorkspaceMembersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z
    .enum([
      'fullName',
      'displayName',
      'email',
      'accountType',
      'joined',
      'status',
    ])
    .default('fullName'),
  sortDirection: z.enum(['asc', 'desc']).default('asc'),
  q: z.string().trim().optional().default(''),
})

export type WorkspaceMembersQueryDto = z.infer<
  typeof WorkspaceMembersQuerySchema
>
