import { forwardRef, Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { ChatModule } from '../chat/chat.module'
import { MessageModule } from '../message/message.module'
import { UploadModule } from '../upload/upload.module'
import { LaterController } from './later.controller'
import { LaterService } from './later.service'
import { LaterReminderProcessor } from './processors/later-reminder.processor'

@Module({
  imports: [
    UploadModule,
    forwardRef(() => MessageModule),
    forwardRef(() => ChatModule),
    // BullMQ queue for reminder notifications. The processor reads from this
    // queue when the `delay` (set to remindAt - now) elapses.
    BullModule.registerQueue({
      name: 'later-reminders',
    }),
  ],
  controllers: [LaterController],
  providers: [LaterService, LaterReminderProcessor],
  exports: [LaterService],
})
export class LaterModule {}
