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
} from '@nestjs/common'
import type { Request } from 'express'
import { Throttle, SkipThrottle } from '@nestjs/throttler'
import { MessageService } from './message.service'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  AddReactionSchema,
  CreateMessageSchema,
  UpdateMessageSchema,
  type AddReactionDto,
  type CreateMessageDto,
  type UpdateMessageDto,
} from './dto/create-message.dto'

@Controller()
@UseGuards(JwtAuthGuard)
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
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.getMessages(channelId, userId, cursor)
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
  async createMessage(
    @Param('channelId') channelId: string,
    @Body(new ZodValidationPipe(CreateMessageSchema)) dto: CreateMessageDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const message = await this.messageService.createMessage(
      channelId,
      userId,
      dto,
    )

    // Broadcast tới tất cả TRONG room TRỪ người gửi (nếu có socketId)
    this.broadcastService.broadcastMessage(channelId, message, socketId)

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
    this.broadcastService.broadcastMessageUpdated(
      updated.channelId,
      updated,
      socketId,
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
    this.broadcastService.broadcastMessageDeleted(
      result.channelId,
      messageId,
      socketId,
    )
    return result
  }

  @Post('messages/:messageId/reactions')
  @HttpCode(HttpStatus.OK)
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
    this.broadcastService.broadcastReactionUpdate(
      result.channelId,
      { messageId, action: result.action, emoji: result.emoji, userId },
      socketId,
    )
    return result
  }
}
