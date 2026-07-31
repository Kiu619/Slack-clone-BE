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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { Idempotent } from '../auth/decorators/idempotent.decorator'
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { DirectMessageService } from './direct-message.service'
import {
  CreateDirectMessageSchema,
  type CreateDirectMessageDto,
} from './dto/direct-message.dto'
import {
  AddConversationMembersSchema,
  type AddConversationMembersDto,
} from './dto/add-conversation-members.dto'
import {
  UpdateConversationSchema,
  type UpdateConversationDto,
} from './dto/update-conversation.dto'

@Controller('workspaces/:workspaceId/direct-messages')
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class DirectMessageController {
  constructor(private readonly directMessageService: DirectMessageService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent(60)
  async getOrCreateConversation(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateDirectMessageSchema))
    dto: CreateDirectMessageDto,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.getOrCreateConversation(userId, {
      ...dto,
      workspaceId,
    })
  }

  @Get()
  async getConversations(
    @Param('workspaceId') workspaceId: string,
    @Query('q') q: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.getConversations(workspaceId, userId, q)
  }

  @Get(':conversationId/invite-candidates')
  async getInviteCandidates(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Query('q') q: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.getInviteCandidates(
      workspaceId,
      conversationId,
      userId,
      q,
    )
  }

  @Post(':conversationId/members/bulk')
  @HttpCode(HttpStatus.OK)
  async addAllConversationMembers(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.addAllWorkspaceMembersToConversation(
      workspaceId,
      conversationId,
      userId,
    )
  }

  @Post(':conversationId/members')
  @HttpCode(HttpStatus.OK)
  async addConversationMembers(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(AddConversationMembersSchema))
    dto: AddConversationMembersDto,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.addConversationMembers(
      workspaceId,
      conversationId,
      userId,
      dto.userIds,
    )
  }

  @Put(':conversationId/star')
  @HttpCode(HttpStatus.OK)
  async starConversation(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.starConversation(
      workspaceId,
      conversationId,
      userId,
      socketId,
    )
  }

  @Delete(':conversationId/star')
  @HttpCode(HttpStatus.OK)
  async unstarConversation(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.unstarConversation(
      workspaceId,
      conversationId,
      userId,
      socketId,
    )
  }

  @Patch(':conversationId')
  async updateConversation(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(UpdateConversationSchema))
    dto: UpdateConversationDto,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.updateConversation(
      workspaceId,
      conversationId,
      userId,
      dto,
    )
  }

  @Get(':conversationId')
  async getConversationById(
    @Param('workspaceId') workspaceId: string,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.directMessageService.getConversationById(
      conversationId,
      userId,
      workspaceId,
    )
  }
}
