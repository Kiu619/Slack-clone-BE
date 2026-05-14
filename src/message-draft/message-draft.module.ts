import { Module } from '@nestjs/common'
import { ChatModule } from '../chat/chat.module'
import { MessageDraftController } from './message-draft.controller'
import { MessageDraftService } from './message-draft.service'

@Module({
  imports: [ChatModule],
  controllers: [MessageDraftController],
  providers: [MessageDraftService],
  exports: [MessageDraftService],
})
export class MessageDraftModule {}
