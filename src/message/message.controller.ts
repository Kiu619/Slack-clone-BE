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
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import type { Request } from 'express'
import { Throttle, SkipThrottle } from '@nestjs/throttler'
import { MessageService } from './message.service'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { Idempotent } from '../auth/decorators/idempotent.decorator'
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  AddReactionSchema,
  CreateMessageSchema,
  UpdateMessageSchema,
  type AddReactionDto,
  type CreateMessageDto,
  type UpdateMessageDto,
} from './dto/create-message.dto'
import {
  ForwardMessageSchema,
  type ForwardMessageDto,
} from './dto/forward-message.dto'
import {
  SearchWorkspaceMessagesSchema,
  type SearchWorkspaceMessagesDto,
} from './dto/search-workspace-messages.dto'

@Controller()
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly broadcastService: ChatBroadcastService,
  ) {}

  /**
   * GET messages — dùng rate limit global (60 req/min) là đủ,
   * không cần limit riêng cho read operation.
   */
  @Get('channels/:channelId/messages')
  @SkipThrottle({ message: true }) // chỉ skip bucket "message", vẫn áp dụng "global"
  getMessages(
    @Param('channelId') channelId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('direction') direction: 'forward' | 'backward' | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.getMessages(
      { channelId },
      userId,
      cursor,
      direction || 'backward',
    )
  }

  /**
   * GET /channels/:channelId/attachments?cursor=
   * Danh sách file trong channel (phân trang), tab Files.
   */
  @Get('channels/:channelId/attachments')
  @SkipThrottle({ message: true })
  listChannelAttachments(
    @Param('channelId') channelId: string,
    @Query('cursor') cursor: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.listAttachments({ channelId }, userId, cursor)
  }

  /**
   * GET /channels/:channelId/files/search?q=
   * Tìm attachment theo tên trong channel (tab Files).
   */
  @Get('channels/:channelId/files/search')
  @SkipThrottle({ message: true })
  searchChannelFiles(
    @Param('channelId') channelId: string,
    @Query('q') q: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.searchFiles({ channelId }, userId, q ?? '')
  }

  /**
   * GET /messages/:messageId
   * Fetch một message cụ thể (dùng sau khi attachments được thêm)
   */
  @Get('messages/:messageId')
  @SkipThrottle({ message: true })
  getMessageById(@Param('messageId') messageId: string, @Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.getMessageById(messageId, userId)
  }

  /**
   * POST /messages/:messageId/forward
   * Forward message to multiple channels / DMs (same workspace).
   */
  @Post('messages/:messageId/forward')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ message: { ttl: 10000, limit: 10 } })
  @Idempotent(300)
  @UseInterceptors(IdempotencyInterceptor)
  async forwardMessages(
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(ForwardMessageSchema)) dto: ForwardMessageDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const list = await this.messageService.forwardMessages(
      messageId,
      userId,
      dto,
    )
    for (const message of list) {
      const m = message as {
        channelId?: string | null
        conversationId?: string | null
      }
      const room = m.channelId
        ? `channel:${m.channelId}`
        : `conversation:${m.conversationId}`
      this.broadcastService.broadcastMessage(room, message, socketId)
    }
    return { messages: list }
  }

  /**
   * GET /messages/:parentId/replies
   * Lấy danh sách reply trong một thread.
   */
  @Get('messages/:parentId/replies')
  @SkipThrottle({ message: true })
  getThreadMessages(
    @Param('parentId') parentId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('direction') direction: 'forward' | 'backward' | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.getThreadMessages(
      parentId,
      userId,
      cursor,
      direction || 'backward',
    )
  }

  /**
   * POST /channels/:channelId/messages
   *
   * Header X-Socket-Id: socket.id của client gửi request.
   * Dùng để exclude sender khỏi WebSocket broadcast — tránh duplicate
   * vì sender đã có message trong cache qua optimistic update.
   *
   * User info (name, avatar) luôn lấy từ DB trong MessageService
   * → avatar/name real-time khi user thay đổi (Slack behavior).
   *
   * Rate limit: 10 messages / 10s per user (bucket "message")
   * → chống spam chat, cho phép burst ngắn nhưng không liên tục.
   */
  @Post('channels/:channelId/messages')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ message: { ttl: 10000, limit: 10 } })
  @Idempotent(60)
  async createMessage(
    @Param('channelId') channelId: string,
    @Body(new ZodValidationPipe(CreateMessageSchema)) dto: CreateMessageDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const message = await this.messageService.createMessage(
      { channelId },
      userId,
      dto,
    )

    // Broadcast tới tất cả TRONG room TRỪ người gửi (nếu có socketId)
    this.broadcastService.broadcastMessage(
      `channel:${channelId}`,
      message,
      socketId,
    )

    return message
  }

  @Patch('messages/:messageId')
  async updateMessage(
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(UpdateMessageSchema)) dto: UpdateMessageDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const updated = await this.messageService.updateMessage(
      messageId,
      userId,
      dto,
    )
    const room = updated.channelId
      ? `channel:${updated.channelId}`
      : `conversation:${updated.conversationId}`

    // Lấy recipientIds đầy đủ (DM members + Thread subscribers) và workspaceId
    const { recipientIds, workspaceId } =
      await this.messageService.getRecipientIds(messageId, updated.parentId)

    this.broadcastService.broadcastMessageUpdated(
      room,
      updated,
      socketId,
      recipientIds,
      workspaceId,
    )
    return updated
  }

  @Delete('messages/:messageId')
  @HttpCode(HttpStatus.OK)
  async deleteMessage(
    @Param('messageId') messageId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.messageService.deleteMessage(messageId, userId)

    // Lấy recipientIds đầy đủ và workspaceId
    const { recipientIds, workspaceId } =
      await this.messageService.getRecipientIds(messageId, result.parentId)

    this.broadcastService.broadcastMessageDeleted(
      result.room,
      messageId,
      socketId,
      result.parentId ?? undefined,
      recipientIds,
      workspaceId,
    )
    return result
  }

  @Post('messages/:messageId/reactions')
  @HttpCode(HttpStatus.OK)
  @Idempotent(60)
  async toggleReaction(
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(AddReactionSchema)) dto: AddReactionDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.messageService.toggleReaction(
      messageId,
      userId,
      dto,
    )

    // Lấy recipientIds đầy đủ và workspaceId
    const { recipientIds, workspaceId } =
      await this.messageService.getRecipientIds(messageId, result.parentId)

    this.broadcastService.broadcastReactionUpdate(
      result.room,
      {
        messageId,
        action: result.action as 'add' | 'remove',
        emoji: result.emoji,
        userId,
        workspaceId,
        reactions: result.reactions as
          | Array<{
              emoji: string
              count: number
              userIds: string[]
              users: Array<{
                id: string
                name: string | null
                displayName: string | null
                avatar: string | null
              }>
            }>
          | undefined,
      },
      socketId,
      result.parentId ?? undefined,
      recipientIds,
    )
    return result
  }

  @Patch('messages/:messageId/pin')
  async togglePin(
    @Param('messageId') messageId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.messageService.togglePin(messageId, userId)

    // Lấy recipientIds đầy đủ và workspaceId
    const { recipientIds, workspaceId } =
      await this.messageService.getRecipientIds(messageId, result.parentId)

    this.broadcastService.broadcastMessagePinned(
      result.room,
      { messageId, isPinned: result.isPinned },
      socketId,
      result.parentId ?? undefined,
      recipientIds,
      workspaceId,
    )
    return result
  }

  @Get('channels/:channelId/pinned')
  @SkipThrottle({ message: true })
  getPinnedChannelMessages(
    @Param('channelId') channelId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.getPinnedMessages({ channelId }, userId)
  }

  @Get('direct-messages/:conversationId/pinned')
  @SkipThrottle({ message: true })
  getPinnedConversationMessages(
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.getPinnedMessages({ conversationId }, userId)
  }

  /**
   * GET /workspaces/:workspaceId/direct-messages/:conversationId/attachments?cursor=
   * Danh sách file trong DM conversation (phân trang), tab Files.
   */
  @Get('direct-messages/:conversationId/attachments')
  @SkipThrottle({ message: true })
  listConversationAttachments(
    @Param('conversationId') conversationId: string,
    @Query('cursor') cursor: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.listAttachments(
      { conversationId },
      userId,
      cursor,
    )
  }

  /**
   * GET /workspaces/:workspaceId/direct-messages/:conversationId/files/search?q=
   * Tìm attachment theo tên trong DM conversation (tab Files).
   */
  @Get('direct-messages/:conversationId/files/search')
  @SkipThrottle({ message: true })
  searchConversationFiles(
    @Param('conversationId') conversationId: string,
    @Query('q') q: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.searchFiles({ conversationId }, userId, q ?? '')
  }

  @Get('direct-messages/:conversationId/messages')
  @SkipThrottle({ message: true })
  getDirectMessages(
    @Param('conversationId') conversationId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('direction') direction: 'forward' | 'backward' | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.getMessages(
      { conversationId },
      userId,
      cursor,
      direction || 'backward',
    )
  }

  @Get('workspaces/:workspaceId/threads')
  @SkipThrottle({ message: true })
  getThreads(
    @Param('workspaceId') workspaceId: string,
    @Query('cursor') cursor: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.getThreads(workspaceId, userId, cursor)
  }

  @Get('workspaces/:workspaceId/search/messages')
  @SkipThrottle({ message: true })
  searchWorkspaceMessages(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(SearchWorkspaceMessagesSchema))
    query: SearchWorkspaceMessagesDto,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.searchWorkspaceMessages(
      workspaceId,
      userId,
      query,
    )
  }

  @Patch('messages/:parentId/threads/read')
  @HttpCode(HttpStatus.OK)
  async markThreadAsRead(
    @Param('parentId') parentId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    await this.messageService.markThreadAsRead(parentId, userId)
    return { success: true }
  }

  @Post('direct-messages/messages')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent(60)
  async createDirectMessageWithoutId(
    @Body(new ZodValidationPipe(CreateMessageSchema)) dto: CreateMessageDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const message = await this.messageService.createMessage({}, userId, dto)
    this.broadcastService.broadcastMessage(
      `conversation:${message.conversationId}`,
      message,
      socketId,
    )
    return message
  }

  @Post('direct-messages/:conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent(60)
  async createDirectMessage(
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(CreateMessageSchema)) dto: CreateMessageDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const message = await this.messageService.createMessage(
      { conversationId },
      userId,
      dto,
    )
    this.broadcastService.broadcastMessage(
      `conversation:${conversationId}`,
      message,
      socketId,
    )
    return message
  }
}
