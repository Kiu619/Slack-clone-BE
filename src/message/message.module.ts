import { forwardRef, Module } from '@nestjs/common'
import { MessageController } from './message.controller'
import { MessageService } from './message.service'
import { ChatModule } from '../chat/chat.module'
import { AttachmentModule } from '../attachment/attachment.module'
import { OfficePreviewModule } from '../attachment-preview/office-preview.module'
import { LaterModule } from '../later/later.module'
import { UploadModule } from '../upload/upload.module'
import { WorkspacePermissionsModule } from '../workspace/workspace-permissions.module'

@Module({
  /**
   * forwardRef: giải circular dependency với ChatModule
   * MessageModule import ChatModule (dùng ChatBroadcastService)
   * ChatModule import MessageModule (dùng MessageService)
   */
  imports: [
    forwardRef(() => ChatModule),
    AttachmentModule,
    OfficePreviewModule,
    forwardRef(() => LaterModule),
    UploadModule,
    WorkspacePermissionsModule,
  ],
  controllers: [MessageController],
  providers: [MessageService],
  exports: [MessageService],
})
export class MessageModule {}
