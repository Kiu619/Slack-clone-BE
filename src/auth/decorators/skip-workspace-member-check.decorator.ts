import { SetMetadata } from '@nestjs/common'

export const SKIP_WORKSPACE_MEMBER_CHECK_KEY = 'skipWorkspaceMemberCheck'
export const REQUIRE_WORKSPACE_MEMBER_CHECK_KEY = 'requireWorkspaceMemberCheck'

/**
 * Decorator to skip workspace member check for specific routes.
 * Use for routes that don't require workspace membership:
 * - POST /workspaces (creating a new workspace)
 * - GET /workspaces (listing user's workspaces)
 * - Routes without workspace context
 */
export const SkipWorkspaceMemberCheck = () =>
  SetMetadata(SKIP_WORKSPACE_MEMBER_CHECK_KEY, true)
