import { forwardRef, Module } from '@nestjs/common'
import { ChatModule } from '../chat/chat.module'
import { LaterModule } from '../later/later.module'
import { MessageModule } from '../message/message.module'
import { UploadModule } from '../upload/upload.module'
import { WorkspacePermissionsModule } from '../workspace/workspace-permissions.module'
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
    LaterModule,
    UploadModule,
    WorkspacePermissionsModule,
  ],
  controllers: [AttachmentController],
  providers: [AttachmentService],
  exports: [AttachmentService],
})
export class AttachmentModule {}
