import { Module, Global } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { NotificationService } from './notification.service'
import { NotificationProcessor } from './processors/notification.processor'
import { NotificationController } from './notification.controller'
import { ChatModule } from '../chat/chat.module'
import { AttachmentModule } from '../attachment/attachment.module'

@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'notification',
    }),
    ChatModule,
    AttachmentModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationProcessor],
  exports: [NotificationService, BullModule],
})
export class NotificationModule {}
