import { forwardRef, Module } from '@nestjs/common'
import { ChatModule } from '../chat/chat.module'
import { MessageModule } from '../message/message.module'
import { UploadModule } from '../upload/upload.module'
import { LaterController } from './later.controller'
import { LaterService } from './later.service'

@Module({
  imports: [UploadModule, forwardRef(() => MessageModule), ChatModule],
  controllers: [LaterController],
  providers: [LaterService],
  exports: [LaterService],
})
export class LaterModule {}
