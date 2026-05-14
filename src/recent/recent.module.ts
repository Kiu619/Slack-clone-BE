import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { ChatModule } from '../chat/chat.module'
import { RecentController } from './recent.controller'
import { RecentService } from './recent.service'

@Module({
  imports: [DatabaseModule, ChatModule],
  controllers: [RecentController],
  providers: [RecentService],
})
export class RecentModule {}
