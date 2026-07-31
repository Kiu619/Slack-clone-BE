import { z } from 'zod'

export const WorkspacePermissionRolesSchema = z.object({
  member: z.boolean(),
  admin: z.boolean(),
  owner: z.boolean(),
  primary_owner: z.boolean(),
})

export const UpdateWorkspacePermissionSchema = z.object({
  roles: WorkspacePermissionRolesSchema,
})

export type UpdateWorkspacePermissionDto = z.infer<
  typeof UpdateWorkspacePermissionSchema
>
