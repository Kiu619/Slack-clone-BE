import { forwardRef, Module } from '@nestjs/common'
import { ChatModule } from '../chat/chat.module'
import { MessageModule } from '../message/message.module'
import { UploadModule } from '../upload/upload.module'
import { AttachmentController } from './attachment.controller'
import { AttachmentService } from './attachment.service'

@Module({
  /**
   * forwardRef để tránh circular dependency:
   * AttachmentModule → MessageModule → AttachmentModule
   */
  imports: [
    forwardRef(() => MessageModule),
    forwardRef(() => ChatModule),
    UploadModule,
  ],
  controllers: [AttachmentController],
  providers: [AttachmentService],
  exports: [AttachmentService],
})
export class AttachmentModule {}
