import { Module, forwardRef } from '@nestjs/common'
import { DirectMessageService } from './direct-message.service'
import { DirectMessageController } from './direct-message.controller'
import { MessageModule } from '../message/message.module'
import { ChatModule } from '../chat/chat.module'

@Module({
  imports: [forwardRef(() => MessageModule), forwardRef(() => ChatModule)],
  controllers: [DirectMessageController],
  providers: [DirectMessageService],
})
export class DirectMessageModule {}
