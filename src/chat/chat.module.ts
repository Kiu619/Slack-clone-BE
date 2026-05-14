import { forwardRef, Module } from '@nestjs/common'
import { MainGateway } from './main.gateway'
import { ChatBroadcastService } from './chat-broadcast.service'
import { UnifiedBroadcastService } from './unified-broadcast.service'
import { MessageModule } from '../message/message.module'
import { JwtModule } from '@nestjs/jwt'
import { UserProfileModule } from '../user-profile/user-profile.module'
import { ChannelModule } from '../channel/channel.module'

@Module({
  imports: [
    JwtModule,
    forwardRef(() => MessageModule),
    forwardRef(() => UserProfileModule),
    forwardRef(() => ChannelModule),
  ],
  providers: [
    MainGateway,
    ChatBroadcastService,
    UnifiedBroadcastService,
  ],
  exports: [ChatBroadcastService, UnifiedBroadcastService],
})
export class ChatModule {}
