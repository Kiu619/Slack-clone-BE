import {
  ForbiddenException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common'
import type { Request } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { HuddleService } from './huddle.service'
import { z } from 'zod'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  GetWorkspaceHuddlesQuerySchema,
  type GetWorkspaceHuddlesQuery,
  GetRecentHuddlesQuerySchema,
  type GetRecentHuddlesQuery,
} from './dto/get-workspace-huddles.dto'
import {
  GetWeeklyHuddlesQuerySchema,
  type GetWeeklyHuddlesQuery,
} from './dto/get-weekly-huddles.dto'

const UpdateTopicDto = z.object({
  topic: z.string().max(200).nullable(),
})
type UpdateTopicDto = z.infer<typeof UpdateTopicDto>

@Controller('workspaces/:workspaceId')
@UseGuards(JwtAuthGuard)
export class HuddleController {
  constructor(private readonly huddleService: HuddleService) {}

  private getUserId(req: Request) {
    const user = req.user as { id: string } | undefined
    if (!user?.id) {
      throw new ForbiddenException('Missing authenticated user')
    }
    return user.id
  }

  @Get('huddles')
  getWorkspaceHuddles(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(GetWorkspaceHuddlesQuerySchema))
    query: GetWorkspaceHuddlesQuery,
    @Req() req: Request,
  ) {
    return this.huddleService.getWorkspaceHuddles(
      workspaceId,
      this.getUserId(req),
      query,
    )
  }

  @Get('huddles/recent')
  getRecentHuddles(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(GetRecentHuddlesQuerySchema))
    query: GetRecentHuddlesQuery,
    @Req() req: Request,
  ) {
    return this.huddleService.getRecentHuddles(
      workspaceId,
      this.getUserId(req),
      query,
    )
  }

  @Get('huddles/weekly')
  getWeeklyHuddles(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(GetWeeklyHuddlesQuerySchema))
    query: GetWeeklyHuddlesQuery,
    @Req() req: Request,
  ) {
    return this.huddleService.getWeeklyHuddles(
      workspaceId,
      this.getUserId(req),
      query.pageSize,
    )
  }

  @Get('channels/:channelId/huddle')
  getChannelState(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
  ) {
    return this.huddleService.getState(
      workspaceId,
      'channel',
      channelId,
      this.getUserId(req),
    )
  }

  @Post('channels/:channelId/huddle/start')
  @HttpCode(HttpStatus.OK)
  startChannelHuddle(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    return this.huddleService.startHuddle(
      workspaceId,
      'channel',
      channelId,
      this.getUserId(req),
      socketId,
    )
  }

  @Post('channels/:channelId/huddle/join')
  @HttpCode(HttpStatus.OK)
  joinChannelHuddle(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    return this.huddleService.joinHuddle(
      workspaceId,
      'channel',
      channelId,
      this.getUserId(req),
      socketId,
    )
  }

  @Post('channels/:channelId/huddle/leave')
  @HttpCode(HttpStatus.OK)
  leaveChannelHuddle(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    return this.huddleService.leaveHuddle(
      workspaceId,
      'channel',
      channelId,
      this.getUserId(req),
      socketId,
    )
  }

  @Get('direct-messages/:conversationId/huddle')
  getConversationState(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ) {
    return this.huddleService.getState(
      workspaceId,
      'dm',
      conversationId,
      this.getUserId(req),
    )
  }

  @Post('direct-messages/:conversationId/huddle/start')
  @HttpCode(HttpStatus.OK)
  startConversationHuddle(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    return this.huddleService.startHuddle(
      workspaceId,
      'dm',
      conversationId,
      this.getUserId(req),
      socketId,
    )
  }

  @Post('direct-messages/:conversationId/huddle/join')
  @HttpCode(HttpStatus.OK)
  joinConversationHuddle(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    return this.huddleService.joinHuddle(
      workspaceId,
      'dm',
      conversationId,
      this.getUserId(req),
      socketId,
    )
  }

  @Post('direct-messages/:conversationId/huddle/leave')
  @HttpCode(HttpStatus.OK)
  leaveConversationHuddle(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    return this.huddleService.leaveHuddle(
      workspaceId,
      'dm',
      conversationId,
      this.getUserId(req),
      socketId,
    )
  }

  @Post('huddles/:huddleId/participants/:participantIdentity/mute')
  @HttpCode(HttpStatus.OK)
  muteParticipant(
    @Param('workspaceId') workspaceId: string,
    @Param('huddleId') huddleId: string,
    @Param('participantIdentity') participantIdentity: string,
    @Req() req: Request,
  ) {
    return this.huddleService.muteParticipant(
      workspaceId,
      huddleId,
      participantIdentity,
      this.getUserId(req),
    )
  }

  @Patch('huddles/:huddleId/topic')
  @HttpCode(HttpStatus.OK)
  updateTopic(
    @Param('workspaceId') workspaceId: string,
    @Param('huddleId') huddleId: string,
    @Body(new ZodValidationPipe(UpdateTopicDto)) body: UpdateTopicDto,
    @Req() req: Request,
  ) {
    return this.huddleService.updateTopic(
      workspaceId,
      huddleId,
      body.topic,
      this.getUserId(req),
    )
  }
}
