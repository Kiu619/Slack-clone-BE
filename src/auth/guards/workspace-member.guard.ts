import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { WorkspacePermissionsService } from '../../workspace/workspace-permissions.service'
import {
  SKIP_WORKSPACE_MEMBER_CHECK_KEY,
} from '../decorators/skip-workspace-member-check.decorator'
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator'
import { IS_PUBLIC_KEY } from '../decorators/public.decorator'
import type { WorkspaceRoleKey } from '../../workspace/workspace-permissions.constants'

export interface WorkspaceMembership {
  id: string
  role: WorkspaceRoleKey
  membershipStatus: 'active' | 'deactivated'
}

declare global {
  namespace Express {
    interface Request {
      workspaceMembership?: WorkspaceMembership
    }
  }
}

@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: WorkspacePermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()

    // Skip entirely for public routes (e.g., /auth/*)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) {
      return true
    }

    const user = request.user as { id: string } | undefined

    if (!user?.id) {
      throw new ForbiddenException('User not authenticated')
    }

    const workspaceId = this.extractWorkspaceId(request)

    // If no workspaceId in params, skip unless explicitly required
    if (!workspaceId) {
      const skipCheck = this.reflector.getAllAndOverride<boolean>(
        SKIP_WORKSPACE_MEMBER_CHECK_KEY,
        [context.getHandler(), context.getClass()],
      )
      return skipCheck !== false // default is true (skip)
    }

    // Has workspaceId - perform membership check
    const skipCheck = this.reflector.getAllAndOverride<boolean>(
      SKIP_WORKSPACE_MEMBER_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    )

    if (skipCheck) {
      return true
    }

    const userId = user.id

    const membership = await this.permissionsService.getWorkspaceMembership(
      workspaceId,
      userId,
    )

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }

    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }

    request.workspaceMembership = membership

    const requiredPermission = this.reflector.getAllAndOverride<string>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    )

    if (requiredPermission) {
      const allowed = await this.permissionsService.canUser(
        workspaceId,
        userId,
        requiredPermission as any,
      )

      if (!allowed) {
        throw new ForbiddenException(
          'You do not have permission to perform this action',
        )
      }
    }

    return true
  }

  private extractWorkspaceId(request: any): string | null {
    return request.params?.workspaceId ?? null
  }
}
