import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Req,
  HttpCode,
  HttpStatus,
  Delete,
  Query,
} from '@nestjs/common'
import type { Request } from 'express'
import { WorkspaceService } from './workspace.service'
import { SkipWorkspaceMemberCheck } from '../auth/decorators/skip-workspace-member-check.decorator'
import {
  CreateWorkspaceSchema,
  type CreateWorkspaceDto,
} from './dto/create-workspace.dto'
import {
  UpdateMemberStatusSchema,
  type UpdateMemberStatusDto,
} from './dto/update-member-status.dto'
import {
  InviteEmailsSchema,
  type InviteEmailsDto,
} from './dto/invite-emails.dto'
import {
  WorkspaceMembersQuerySchema,
  type WorkspaceMembersQueryDto,
} from './dto/workspace-members-query.dto'
import {
  UpdateMemberRoleSchema,
  type UpdateMemberRoleDto,
} from './dto/update-member-role.dto'
import {
  UpdateWorkspacePermissionSchema,
  type UpdateWorkspacePermissionDto,
} from './dto/update-workspace-permission.dto'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import type { WorkspacePermissionKey } from './workspace-permissions.constants'

@Controller('workspaces')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @SkipWorkspaceMemberCheck()
  create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(CreateWorkspaceSchema)) dto: CreateWorkspaceDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.create(userId, dto)
  }

  @Get()
  @SkipWorkspaceMemberCheck()
  findAll(@Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.findAllByUser(userId)
  }

  @Get(':workspaceId')
  findOne(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.findOne(workspaceId, userId)
  }

  @Get(':workspaceId/permissions')
  getPermissions(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.getPermissions(workspaceId, userId)
  }

  @Get(':workspaceId/members')
  getMembers(@Req() req: Request, @Param('workspaceId') workspaceId: string) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.getMembers(workspaceId, userId)
  }

  @Get(':workspaceId/members/page')
  getMembersPage(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(WorkspaceMembersQuerySchema))
    query: WorkspaceMembersQueryDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.getMembersPage(workspaceId, userId, query)
  }

  @Patch(':workspaceId/members/:userId/role')
  updateMemberRole(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') targetUserId: string,
    @Body(new ZodValidationPipe(UpdateMemberRoleSchema))
    dto: UpdateMemberRoleDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.updateMemberRole(
      workspaceId,
      userId,
      targetUserId,
      dto,
    )
  }

  @Patch(':workspaceId/permissions/:permissionKey')
  updatePermission(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('permissionKey') permissionKey: string,
    @Body(new ZodValidationPipe(UpdateWorkspacePermissionSchema))
    dto: UpdateWorkspacePermissionDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.updatePermission(
      workspaceId,
      userId,
      permissionKey as WorkspacePermissionKey,
      dto,
    )
  }

  @Patch(':workspaceId/members/:userId/deactivate')
  deactivateMember(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') targetUserId: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.updateWorkspaceMemberAccessStatus(
      workspaceId,
      userId,
      targetUserId,
      'deactivated',
    )
  }

  @Patch(':workspaceId/members/:userId/activate')
  activateMember(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') targetUserId: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.updateWorkspaceMemberAccessStatus(
      workspaceId,
      userId,
      targetUserId,
      'active',
    )
  }

  @Delete(':workspaceId/members/:userId')
  removeDeactivatedMember(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') targetUserId: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.removeDeactivatedWorkspaceMember(
      workspaceId,
      userId,
      targetUserId,
    )
  }

  @Post(':workspaceId/invite-emails')
  @HttpCode(HttpStatus.OK)
  inviteEmails(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(InviteEmailsSchema)) dto: InviteEmailsDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.sendWorkspaceInvitesByEmail(
      workspaceId,
      userId,
      dto.emails,
      dto.channelId,
    )
  }

  @Get(':workspaceId/members/:userId/status')
  getMemberStatus(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') targetUserId: string,
  ) {
    const { id: requestingUserId } = req.user as { id: string }
    return this.workspaceService.getMemberStatus(
      workspaceId,
      targetUserId,
      requestingUserId,
    )
  }

  @Patch(':workspaceId/member/status')
  updateMemberStatus(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateMemberStatusSchema))
    dto: UpdateMemberStatusDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.updateMemberStatus(userId, workspaceId, dto)
  }

  @Delete(':workspaceId/member/status')
  clearMemberStatus(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.clearMemberStatus(userId, workspaceId)
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  @SkipWorkspaceMemberCheck()
  join(@Req() req: Request, @Body('inviteCode') inviteCode: string) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.joinByInviteCode(userId, inviteCode)
  }
}
