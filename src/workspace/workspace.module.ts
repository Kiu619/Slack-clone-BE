import { Module } from '@nestjs/common'
import { WorkspaceController } from './workspace.controller'
import { WorkspaceService } from './workspace.service'
import { UserProfileModule } from '../user-profile/user-profile.module'
import { ChannelModule } from '../channel/channel.module'
import { ChatModule } from '../chat/chat.module'
import { WorkspacePermissionsModule } from './workspace-permissions.module'
import { WorkspaceEmojisModule } from '../workspace-emojis/workspace-emojis.module'

@Module({
  imports: [
    UserProfileModule,
    ChannelModule,
    ChatModule,
    WorkspacePermissionsModule,
    WorkspaceEmojisModule,
  ],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
