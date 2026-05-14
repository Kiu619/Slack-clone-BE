import { forwardRef, Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { MessageModule } from '../message/message.module'
import { ChatModule } from '../chat/chat.module'
import { ScheduledMessageService } from './scheduled-message.service'
import { ScheduledMessageController } from './scheduled-message.controller'
import { ScheduledMessageProcessor } from './processors/scheduled-message.processor'

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'scheduled-messages',
    }),
    forwardRef(() => MessageModule),
    forwardRef(() => ChatModule),
  ],
  controllers: [ScheduledMessageController],
  providers: [ScheduledMessageService, ScheduledMessageProcessor],
  exports: [ScheduledMessageService],
})
export class ScheduledMessageModule {}
