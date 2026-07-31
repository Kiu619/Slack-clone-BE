import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
import { MessageService } from '../message/message.service'
import { AttachmentService } from './attachment.service'
import type {
  CreateAttachmentDto,
  SearchAttachmentsDto,
} from './dto/create-attachment.dto'
import {
  CreateAttachmentSchema,
  SearchAttachmentsSchema,
} from './dto/create-attachment.dto'

@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentController {
  constructor(
    private readonly attachmentService: AttachmentService,
    private readonly messageService: MessageService,
    private readonly broadcastService: ChatBroadcastService,
  ) {}

  @Get()
  async searchAttachments(
    @Query(new ZodValidationPipe(SearchAttachmentsSchema))
    dto: SearchAttachmentsDto,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.attachmentService.searchAttachments(dto, userId)
  }

  @Post()
  async createAttachment(
    @Body(new ZodValidationPipe(CreateAttachmentSchema))
    dto: CreateAttachmentDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }

    const attachment = await this.attachmentService.createAttachment(
      dto,
      userId,
    )

    const message = await this.messageService.getMessageById(
      dto.messageId,
      userId,
    )

    const room = message.channelId
      ? `channel:${message.channelId}`
      : `conversation:${message.conversationId}`

    void this.broadcastService.broadcastAttachmentAdded(
      room,
      { messageId: dto.messageId, attachment },
      socketId,
      (message as any).recipientIds,
      (message as any).parentId ?? undefined,
      (message as any).workspaceId as string | undefined,
    )

    return attachment
  }

  @Post(':id/view')
  async trackView(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    console.log('trackView', id, userId, workspaceId)
    return this.attachmentService.trackView(id, userId, workspaceId)
  }

  @Delete(':id')
  async deleteAttachment(
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const result = await this.attachmentService.deleteAttachment(id, userId)

    const room = result.channelId
      ? `channel:${result.channelId}`
      : `conversation:${result.conversationId}`

    const message = await this.messageService.getMessageById(
      result.messageId,
      userId,
    )

    void this.broadcastService.broadcastAttachmentDeleted(
      room,
      { messageId: result.messageId, attachmentId: id },
      socketId,
      (message as any).recipientIds,
      (message as any).parentId ?? undefined,
      (message as any).workspaceId as string | undefined,
    )

    return result
  }
}
