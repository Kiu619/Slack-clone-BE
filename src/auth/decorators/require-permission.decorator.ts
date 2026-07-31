import { SetMetadata } from '@nestjs/common'
import type { WorkspacePermissionKey } from '../../workspace/workspace-permissions.constants'

export const REQUIRED_PERMISSION_KEY = 'requiredPermission'

/**
 * Decorator to specify a required permission for the route.
 * The WorkspaceMemberGuard will check if the user has this permission.
 *
 * @example
 * @Post()
 * @RequirePermission('create_private_channels')
 * async createChannel(...) { }
 */
export const RequirePermission = (permission: WorkspacePermissionKey) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission)
