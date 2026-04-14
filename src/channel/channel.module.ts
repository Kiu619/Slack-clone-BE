import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { ChannelController } from './channel.controller'
import { ChannelService } from './channel.service'
import { ChannelGateway } from './channel.gateway'
import { ChannelBroadcastService } from './channel-broadcast.service'
import { DatabaseModule } from '../database/database.module'

@Module({
  imports: [DatabaseModule, JwtModule],
  controllers: [ChannelController],
  providers: [
    ChannelService,
    ChannelGateway,
    ChannelBroadcastService,
  ],
  exports: [ChannelService, ChannelBroadcastService],
})
export class ChannelModule {}
