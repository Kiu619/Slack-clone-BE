import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import type { Request } from 'express'
import { ChannelService } from './channel.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { Idempotent } from '../auth/decorators/idempotent.decorator'
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor'
import {
  CreateChannelSchema,
  type CreateChannelDto,
} from './dto/create-channel.dto'
import {
  AddChannelMemberSchema,
  type AddChannelMemberDto,
} from './dto/add-channel-member.dto'
import {
  UpdateChannelSchema,
  type UpdateChannelDto,
} from './dto/update-channel.dto'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { ChannelBroadcastService } from './channel-broadcast.service'

@Controller('workspaces/:workspaceId/channels')
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class ChannelController {
  constructor(
    private readonly channelService: ChannelService,
    private readonly broadcastService: ChannelBroadcastService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent(300)
  async create(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(CreateChannelSchema)) dto: CreateChannelDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const channel = await this.channelService.create(workspaceId, userId, dto)
    this.broadcastService.broadcastChannelCreated(
      workspaceId,
      channel,
      socketId,
    )
    return channel
  }

  @Get()
  findAll(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
    @Query('withUserIds') withUserIdsRaw?: string | string[],
  ) {
    const { id: userId } = req.user as { id: string }
    const withUserIds = Array.isArray(withUserIdsRaw)
      ? withUserIdsRaw
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : (withUserIdsRaw
          ?.split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0) ?? [])
    return this.channelService.findAllByWorkspace(
      workspaceId,
      userId,
      withUserIds,
    )
  }

  @Get(':channelId/member-status')
  getMemberStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.getMemberStatus(channelId, workspaceId, userId)
  }

  @Get(':channelId/members')
  getMembers(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Query('search') search: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.getMembers(
      channelId,
      workspaceId,
      userId,
      search,
    )
  }

  @Post(':channelId/members/bulk')
  @HttpCode(HttpStatus.OK)
  async addAllWorkspaceMembersToChannel(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.channelService.addAllWorkspaceMembersToChannel(
      channelId,
      workspaceId,
      userId,
    )
    for (const affectedUserId of result.addedUserIds) {
      this.broadcastService.broadcastChannelMembershipChanged(
        workspaceId,
        {
          channelId,
          affectedUserId,
          action: 'member_added',
        },
        socketId,
      )
    }
    return { added: result.added }
  }

  @Post(':channelId/members')
  @HttpCode(HttpStatus.CREATED)
  async addChannelMember(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(AddChannelMemberSchema))
    dto: AddChannelMemberDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.channelService.addChannelMember(
      channelId,
      workspaceId,
      userId,
      dto.userId,
    )
    this.broadcastService.broadcastChannelMembershipChanged(
      workspaceId,
      {
        channelId,
        affectedUserId: dto.userId,
        action: 'member_added',
      },
      socketId,
    )
    return result
  }

  @Delete(':channelId/members/:memberUserId')
  @HttpCode(HttpStatus.OK)
  async removeChannelMember(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('memberUserId') memberUserId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.channelService.removeChannelMember(
      channelId,
      workspaceId,
      userId,
      memberUserId,
    )
    this.broadcastService.broadcastChannelMembershipChanged(
      workspaceId,
      {
        channelId,
        affectedUserId: memberUserId,
        action: 'member_removed',
      },
      socketId,
    )
    return result
  }

  @Put(':channelId/star')
  @HttpCode(HttpStatus.OK)
  async starChannel(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.starChannel(
      channelId,
      workspaceId,
      userId,
      socketId,
    )
  }

  @Delete(':channelId/star')
  @HttpCode(HttpStatus.OK)
  async unstarChannel(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.channelService.unstarChannel(
      channelId,
      workspaceId,
      userId,
      socketId,
    )
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

  @Patch(':channelId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(UpdateChannelSchema)) dto: UpdateChannelDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const channel = await this.channelService.update(
      channelId,
      workspaceId,
      userId,
      dto,
    )
    this.broadcastService.broadcastChannelUpdated(
      workspaceId,
      channel,
      socketId,
    )
    return channel
  }

  @Delete(':channelId')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.channelService.delete(
      channelId,
      workspaceId,
      userId,
    )
    this.broadcastService.broadcastChannelDeleted(
      workspaceId,
      channelId,
      socketId,
    )
    return result
  }
}
