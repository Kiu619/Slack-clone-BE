import { forwardRef, Module } from '@nestjs/common'
import { ChatGateway } from './chat.gateway'
import { ChatBroadcastService } from './chat-broadcast.service'
import { MessageModule } from '../message/message.module'
import { JwtModule } from '@nestjs/jwt'

@Module({
  imports: [
    JwtModule,
    /**
     * forwardRef: giải circular dependency
     * ChatModule → MessageModule (để dùng MessageService trong ChatGateway)
     * MessageModule → ChatModule (để dùng ChatBroadcastService trong MessageController)
     */
    forwardRef(() => MessageModule),
  ],
  providers: [ChatGateway, ChatBroadcastService],
  /**
   * Export ChatBroadcastService để MessageModule inject vào MessageController
   */
  exports: [ChatBroadcastService],
})
export class ChatModule {}
