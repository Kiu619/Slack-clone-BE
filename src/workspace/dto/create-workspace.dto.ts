import { z } from 'zod'

export const CreateWorkspaceSchema = z.object({
  name: z
    .string()
    .min(3, 'Workspace name must be at least 3 characters')
    .max(50, 'Workspace name must be at most 50 characters'),
  imageUrl: z.string().optional().default(''),
  inviteCode: z.string().uuid('Invalid invite code'),
  slug: z.string().min(1, 'Slug is required'),
  memberEmails: z.array(z.string().email()).optional().default([]),
})

export type CreateWorkspaceDto = z.infer<typeof CreateWorkspaceSchema>
