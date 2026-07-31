import { forwardRef, Module } from '@nestjs/common'

import { ChatModule } from '../chat/chat.module'
import { WorkspacePermissionsModule } from '../workspace/workspace-permissions.module'
import { WorkspaceEmojisController } from './workspace-emojis.controller'
import { WorkspaceEmojisService } from './workspace-emojis.service'

@Module({
  imports: [WorkspacePermissionsModule, forwardRef(() => ChatModule)],
  controllers: [WorkspaceEmojisController],
  providers: [WorkspaceEmojisService],
  exports: [WorkspaceEmojisService],
})
export class WorkspaceEmojisModule {}
