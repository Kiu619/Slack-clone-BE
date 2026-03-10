import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import type { Request } from 'express'
import { WorkspaceService } from './workspace.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import {
  CreateWorkspaceSchema,
  type CreateWorkspaceDto,
} from './dto/create-workspace.dto'
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
    const { userId } = req.user as { userId: string }
    return this.workspaceService.create(userId, dto)
  }

  @Get()
  findAll(@Req() req: Request) {
    const { userId } = req.user as { userId: string }
    return this.workspaceService.findAllByUser(userId)
  }

  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    const { userId } = req.user as { userId: string }
    return this.workspaceService.findOne(id, userId)
  }

  @Get(':id/members')
  getMembers(@Req() req: Request, @Param('id') id: string) {
    const { userId } = req.user as { userId: string }
    return this.workspaceService.getMembers(id, userId)
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  join(@Req() req: Request, @Body('inviteCode') inviteCode: string) {
    const { userId } = req.user as { userId: string }
    return this.workspaceService.joinByInviteCode(userId, inviteCode)
  }
}
