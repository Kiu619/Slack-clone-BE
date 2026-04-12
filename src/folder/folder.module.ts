import { forwardRef, Module } from '@nestjs/common'
import { ChatModule } from '../chat/chat.module'
import { DatabaseModule } from '../database/database.module'
import { UploadModule } from '../upload/upload.module'
import { FolderController } from './folder.controller'
import { FolderService } from './folder.service'

@Module({
  imports: [DatabaseModule, UploadModule, forwardRef(() => ChatModule)],
  controllers: [FolderController],
  providers: [FolderService],
  exports: [FolderService],
})
export class FolderModule {}
