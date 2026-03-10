import { Module } from '@nestjs/common'
import { ChannelController } from './channel.controller'
import { ChannelService } from './channel.service'
import { DatabaseModule } from '../database/database.module'

@Module({
  imports: [DatabaseModule],
  controllers: [ChannelController],
  providers: [ChannelService],
  exports: [ChannelService],
})
export class ChannelModule {}
