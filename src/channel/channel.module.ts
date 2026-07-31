import { forwardRef, Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { ChannelController } from './channel.controller'
import { ChannelService } from './channel.service'
import { ChannelBroadcastService } from './channel-broadcast.service'
import { DatabaseModule } from '../database/database.module'
import { ChatModule } from '../chat/chat.module'
import { MessageModule } from '../message/message.module'
import { WorkspacePermissionsModule } from '../workspace/workspace-permissions.module'

@Module({
  imports: [
    DatabaseModule,
    JwtModule,
    forwardRef(() => ChatModule),
    forwardRef(() => MessageModule),
    WorkspacePermissionsModule,
  ],
  controllers: [ChannelController],
  providers: [ChannelService, ChannelBroadcastService],
  exports: [ChannelService, ChannelBroadcastService],
})
export class ChannelModule {}
