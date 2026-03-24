import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { ChannelService } from './channel.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import {
  CreateChannelSchema,
  type CreateChannelDto,
} from './dto/create-channel.dto'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'

@Controller('workspaces/:workspaceId/channels')
@UseGuards(JwtAuthGuard)
export class ChannelController {
  constructor(private readonly channelService: ChannelService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(CreateChannelSchema)) dto: CreateChannelDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.create(workspaceId, userId, dto)
  }

  @Get()
  findAll(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.findAllByWorkspace(workspaceId, userId)
  }

  @Get(':channelId')
  findOne(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.findOne(channelId, workspaceId, userId)
  }

  @Delete(':channelId')
  @HttpCode(HttpStatus.OK)
  delete(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.delete(channelId, workspaceId, userId)
  }

  @Get(':channelId/members')
  getMembers(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.getMembers(channelId, workspaceId, userId)
  }
}
