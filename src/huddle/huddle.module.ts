import { forwardRef, Module } from '@nestjs/common'
import { ChatModule } from '../chat/chat.module'
import { DatabaseModule } from '../database/database.module'
import { MessageModule } from '../message/message.module'
import { HuddleBroadcastService } from './huddle-broadcast.service'
import { HuddleController } from './huddle.controller'
import { HuddleService } from './huddle.service'
import { HuddleWebhookController } from './huddle-webhook.controller'

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => MessageModule),
    forwardRef(() => ChatModule),
  ],
  controllers: [HuddleController, HuddleWebhookController],
  providers: [HuddleService, HuddleBroadcastService],
  exports: [HuddleService, HuddleBroadcastService],
})
export class HuddleModule {}
