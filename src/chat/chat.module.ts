import { forwardRef, Module } from '@nestjs/common'
import { MainGateway } from './main.gateway'
import { ChatBroadcastService } from './chat-broadcast.service'
import { UnifiedBroadcastService } from './unified-broadcast.service'
import { MessageModule } from '../message/message.module'
import { JwtModule } from '@nestjs/jwt'
import { UserProfileModule } from '../user-profile/user-profile.module'
import { ChannelModule } from '../channel/channel.module'
import { WorkspacePresenceService } from './workspace-presence.service'
import { RedisPresenceService } from './redis-presence.service'
import { HuddleModule } from '../huddle/huddle.module'
import { RedisModule } from '../redis/redis.module'

@Module({
  imports: [
    JwtModule,
    forwardRef(() => MessageModule),
    forwardRef(() => UserProfileModule),
    forwardRef(() => ChannelModule),
    forwardRef(() => HuddleModule),
    RedisModule, // For RedisService in MainGateway (Redis adapter)
  ],
  providers: [
    MainGateway,
    ChatBroadcastService,
    UnifiedBroadcastService,
    WorkspacePresenceService,
    RedisPresenceService,
  ],
  exports: [
    ChatBroadcastService,
    UnifiedBroadcastService,
    WorkspacePresenceService,
  ],
})
export class ChatModule {}
