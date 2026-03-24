import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  Delete,
} from '@nestjs/common'
import type { Request } from 'express'
import { WorkspaceService } from './workspace.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import {
  CreateWorkspaceSchema,
  type CreateWorkspaceDto,
} from './dto/create-workspace.dto'
import {
  UpdateMemberStatusSchema,
  type UpdateMemberStatusDto,
} from './dto/update-member-status.dto'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(CreateWorkspaceSchema)) dto: CreateWorkspaceDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.create(userId, dto)
  }

  @Get()
  findAll(@Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.findAllByUser(userId)
  }

  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.findOne(id, userId)
  }

  @Get(':id/members')
  getMembers(@Req() req: Request, @Param('id') id: string) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.getMembers(id, userId)
  }

  @Get(':id/members/:userId/status')
  getMemberStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ) {
    const { id: requestingUserId } = req.user as { id: string }
    return this.workspaceService.getMemberStatus(
      id,
      targetUserId,
      requestingUserId,
    )
  }

  @Patch(':id/member/status')
  updateMemberStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateMemberStatusSchema))
    dto: UpdateMemberStatusDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.updateMemberStatus(userId, id, dto)
  }

  @Delete(':id/member/status')
  clearMemberStatus(@Req() req: Request, @Param('id') id: string) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.clearMemberStatus(userId, id)
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  join(@Req() req: Request, @Body('inviteCode') inviteCode: string) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceService.joinByInviteCode(userId, inviteCode)
  }
}
