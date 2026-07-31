import { Module, forwardRef } from '@nestjs/common'
import { AttachmentModule } from '../attachment/attachment.module'
import { DirectMessageService } from './direct-message.service'
import { DirectMessageController } from './direct-message.controller'
import { MessageModule } from '../message/message.module'
import { ChatModule } from '../chat/chat.module'

@Module({
  imports: [
    AttachmentModule,
    forwardRef(() => MessageModule),
    forwardRef(() => ChatModule),
  ],
  controllers: [DirectMessageController],
  providers: [DirectMessageService],
})
export class DirectMessageModule {}
