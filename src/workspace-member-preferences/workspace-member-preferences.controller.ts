import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import type { Request } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { WorkspaceService } from '../workspace/workspace.service'
import { WorkspaceMemberPreferencesService } from './workspace-member-preferences.service'
import {
  UpdateMemberPreferencesSchema,
  type UpdateMemberPreferencesDto,
} from './dto/update-member-preferences.dto'

@Controller()
@UseGuards(JwtAuthGuard)
export class WorkspaceMemberPreferencesController {
  constructor(
    private readonly preferencesService: WorkspaceMemberPreferencesService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  private async assertActiveMember(workspaceId: string, userId: string) {
    const membership = await this.workspaceService.getMemberMembership(workspaceId, userId)
    if (!membership) {
      throw new BadRequestException('You are not a member of this workspace')
    }
    if (membership.membershipStatus !== 'active') {
      throw new BadRequestException('Your workspace membership is deactivated')
    }
    return membership
  }

  @Get('workspaces/:workspaceId/member-preferences')
  @HttpCode(HttpStatus.OK)
  async getPreferences(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
  ) {
    const { id: userId } = req.user as { id: string }
    await this.assertActiveMember(workspaceId, userId)
    return this.preferencesService.getPreferences(workspaceId, userId)
  }

  @Patch('workspaces/:workspaceId/member-preferences')
  @HttpCode(HttpStatus.OK)
  async updatePreferences(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateMemberPreferencesSchema))
    dto: UpdateMemberPreferencesDto,
  ) {
    const { id: userId } = req.user as { id: string }
    await this.assertActiveMember(workspaceId, userId)
    return this.preferencesService.upsertPreferences(workspaceId, userId, dto)
  }
}
