import {
  Body,
  Controller,
  Delete,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'
import { MessageService } from '../message/message.service'
import { AttachmentService } from './attachment.service'
import type { CreateAttachmentDto } from './dto/create-attachment.dto'
import { CreateAttachmentSchema } from './dto/create-attachment.dto'

@Controller('attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentController {
  constructor(
    private readonly attachmentService: AttachmentService,
    private readonly messageService: MessageService,
    private readonly broadcastService: ChatBroadcastService,
  ) {}

  @Post()
  async createAttachment(
    @Body(new ZodValidationPipe(CreateAttachmentSchema))
    dto: CreateAttachmentDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }

    const attachment = await this.attachmentService.createAttachment(dto)

    const message = await this.messageService.getMessageById(
      dto.messageId,
      userId,
    )

    void this.broadcastService.broadcastAttachmentAdded(
      message.channelId,
      { messageId: dto.messageId, attachment },
      socketId,
    )

    return attachment
  }

  @Delete(':id')
  async deleteAttachment(@Param('id') id: string, @Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    return this.attachmentService.deleteAttachment(id, userId)
  }
}
