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
  ToggleThreadMuteSchema,
  type ToggleThreadMuteDto,
} from './dto/toggle-thread-mute.dto'
import {
  FinalizeAttachmentSchema,
  type FinalizeAttachmentDto,
} from './dto/finalize-attachment.dto'
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
  async getMessageById(@Param('messageId') messageId: string, @Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    const message = await this.messageService.getMessageById(messageId, userId)
    // Resolve forward sources cho single message (1 phần tử)
    if (message?.forwardSnapshot) {
      await this.messageService.resolveForwardedSources([message])
    }
    return message
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
   * POST /messages/:messageId/attachments/:pendingUploadId/finalize
   *
   * Sau khi client upload file thật lên S3/Cloudinary (URL đã có),
   * gọi endpoint này để update URL cho attachment row đang pending.
   *
   * Match attachment theo `pendingUploadId` (client-generated uploadId).
   * Chỉ owner message mới được finalize.
   */
  @Post('messages/:messageId/attachments/:pendingUploadId/finalize')
  @HttpCode(HttpStatus.OK)
  @Idempotent(60)
  async finalizeAttachment(
    @Param('messageId') messageId: string,
    @Param('pendingUploadId') pendingUploadId: string,
    @Body(new ZodValidationPipe(FinalizeAttachmentSchema))
    dto: FinalizeAttachmentDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.messageService.finalizeAttachment(
      messageId,
      pendingUploadId,
      userId,
      dto,
    )

    // Lấy broadcast context 1 lần (room + workspaceId) để dùng cho cả 2 broadcast.
    let ctx: { room: string; workspaceId: string } | null = null
    try {
      ctx = await this.messageService.getMessageBroadcastContext(messageId)
    } catch {
      // best-effort
    }

    // Broadcast #1 — attachment update tới room của message để client nào đang xem
    // cũng nhận được URL mới (vd: tab Files, conversation khác).
    // PHẢI broadcast `attachments` array đầy đủ (với URL thật) thay vì chỉ `attachmentFinalized`.
    // Frontend `syncMessageUpdate` chỉ merge data trực tiếp — nếu payload là `{attachmentFinalized: ...}`
    // thì field đó bị ignore vì không phải field hợp lệ trên Message type.
    // → attachment.url vẫn giữ "" → usePdfSource không fetch → PDF skeleton mãi.
    if (ctx) {
      try {
        // DEBUG: Log broadcast payload
        const broadcastPayload = {
          id: messageId,
          attachments: result.fullMessage?.attachments ?? [],
        }
        const attUrl = result.fullMessage?.attachments?.[0]?.url ?? 'N/A'
        console.log(
          `Broadcasting finalizeAttachment - messageId: ${messageId}, ` +
            `broadcastPayload.attachments count: ${broadcastPayload.attachments?.length ?? 'N/A'}, ` +
            `broadcastPayload.attachments[0] URL length: ${broadcastPayload.attachments?.[0]?.url?.length ?? 'N/A'}, ` +
            `broadcastPayload.attachments[0] URL first 120: ${broadcastPayload.attachments?.[0]?.url?.substring(0, 120) ?? 'N/A'}, ` +
            `room: ${ctx.room}, workspaceId: ${ctx.workspaceId}`,
        )
        this.broadcastService.broadcastMessageUpdated(
          ctx.room,
          broadcastPayload,
          socketId,
          [],
          ctx.workspaceId,
        )
      } catch {
        // best-effort
      }
    }

    // Broadcast #2 — Nếu tất cả attachment đã finalize xong (không còn pendingUpload nào)
    // → broadcast CREATE message đầy đủ cho User B để họ thấy bubble.
    // (CREATE đã bị skip ở createMessage vì message còn pendingUpload.)
    //
    // Quan trọng: PHẢI inject workspaceId vào fullMessage, vì broadcastMessage()
    // chỉ phát syncEntity CREATE khi có workspaceId. getMessageById không select field này.
    if (!result.stillPending && result.fullMessage) {
      try {
        const fullMsg = result.fullMessage as {
          channelId?: string | null
          conversationId?: string | null
        }
        const room = fullMsg.channelId
          ? `channel:${fullMsg.channelId}`
          : `conversation:${fullMsg.conversationId}`
        if (room) {
          // Inject workspaceId (required for unified sync to emit)
          let messageWithMetadata: any = ctx
            ? { ...result.fullMessage, workspaceId: ctx.workspaceId }
            : result.fullMessage

          // If this is a reply, also inject parent metadata (replyCount, participantIds)
          // so broadcastMessage() can emit correct UPDATE for the parent message.
          // Without this, parentReplyCount=undefined and User B's replyCount bar doesn't update.
          if (result.fullMessage.parentId) {
            try {
              const parentMeta =
                await this.messageService.getParentThreadMetadata(
                  result.fullMessage.parentId,
                )
              if (parentMeta) {
                messageWithMetadata = {
                  ...messageWithMetadata,
                  parentReplyCount: parentMeta.replyCount,
                  parentReplyParticipantIds: parentMeta.replyParticipantIds,
                  parentContent: parentMeta.content,
                  parentDeletedAt: parentMeta.deletedAt,
                }
              }
            } catch {
              // best-effort — parent metadata is optional for the broadcast to work
            }
          }

          this.broadcastService.broadcastMessage(
            room,
            messageWithMetadata,
            socketId,
          )
        }
      } catch {
        // best-effort
      }
    }

    // Enqueue deferred notification #3 — Nếu đây là finalize cuối cùng (tất cả file đã xong)
    // → gửi notification cho User B (push notification, email, socket notification).
    // Notification này bị deferred trong createMessage vì lúc đó file còn pending.
    if (!result.stillPending) {
      await this.messageService.enqueueDeferredNotification(messageId, userId)
    }

    return result.attachment
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

    // Nếu message có attachment pendingUpload (file chưa upload xong lên S3/Cloudinary)
    // → skip broadcast CREATE cho User B. Sender vẫn nhận response (Optimistic hiển thị).
    // Broadcast CREATE sẽ được gửi ở finalizeAttachment khi file cuối cùng hoàn tất.
    const hasPendingUpload =
      Array.isArray((message as any).attachments) &&
      (message as any).attachments.some((a: any) => a?.pendingUpload === true)

    if (!hasPendingUpload) {
      // Broadcast tới tất cả TRONG room TRỪ người gửi (nếu có socketId)
      this.broadcastService.broadcastMessage(
        `channel:${channelId}`,
        message,
        socketId,
      )
    }

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

    // Nếu message có attachment pendingUpload (file chưa upload xong lên S3/Cloudinary)
    // → skip broadcast UPDATE cho User B. Sender vẫn nhận response (Optimistic hiển thị).
    // Broadcast UPDATE sẽ được gửi ở finalizeAttachment khi file cuối cùng hoàn tất
    // (cùng pattern với createMessage ở line 344-350).
    //
    // VẪN broadcast UPDATE nếu edit chỉ xóa attachments (không có pendingUpload mới)
    // hoặc chỉ sửa text → User B thấy thay đổi ngay, không cần chờ finalize.
    const hasPendingUpload =
      Array.isArray((updated as any).attachments) &&
      (updated as any).attachments.some(
        (a: any) => a?.pendingUpload === true,
      )

    if (!hasPendingUpload) {
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
    }

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

  /**
   * DELETE /messages/:messageId/abort
   *
   * HARD delete cho message có attachments đang pending upload.
   * Chỉ dùng khi client muốn huỷ upload (composer unmount, navigate away, refresh).
   *
   * Chỉ abort được khi tất cả attachments của message vẫn còn pendingUploadId
   * (chưa file nào finalize). Đã finalize thì phải dùng DELETE messages/:id thông thường.
   */
  @Delete('messages/:messageId/abort')
  @HttpCode(HttpStatus.OK)
  async abortPendingMessage(
    @Param('messageId') messageId: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.messageService.abortMessage(messageId, userId)

    // Broadcast message_deleted để mọi client (đã/đang mở channel) đồng bộ xóa message
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

  @Patch('messages/:parentId/threads/mute')
  @HttpCode(HttpStatus.OK)
  async toggleThreadMute(
    @Param('parentId') parentId: string,
    @Body(new ZodValidationPipe(ToggleThreadMuteSchema))
    dto: ToggleThreadMuteDto,
    @Req() req: Request,
    @Query('workspaceId') workspaceId: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageService.toggleThreadMute(
      userId,
      parentId,
      workspaceId,
      dto.isMuted,
    )
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

    // Nếu có attachment pendingUpload → skip broadcast (sẽ broadcast khi finalize xong).
    const hasPendingUpload =
      Array.isArray((message as any).attachments) &&
      (message as any).attachments.some((a: any) => a?.pendingUpload === true)

    if (!hasPendingUpload) {
      this.broadcastService.broadcastMessage(
        `conversation:${message.conversationId}`,
        message,
        socketId,
      )
    }
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

    // Nếu có attachment pendingUpload → skip broadcast (sẽ broadcast khi finalize xong).
    const hasPendingUpload =
      Array.isArray((message as any).attachments) &&
      (message as any).attachments.some((a: any) => a?.pendingUpload === true)

    if (!hasPendingUpload) {
      this.broadcastService.broadcastMessage(
        `conversation:${conversationId}`,
        message,
        socketId,
      )
    }
    return message
  }
}
