import { Module, forwardRef } from '@nestjs/common'
import { WorkspaceController } from './workspace.controller'
import { WorkspaceService } from './workspace.service'
import { UserProfileModule } from '../user-profile/user-profile.module'
import { ChannelModule } from '../channel/channel.module'
import { ChatModule } from '../chat/chat.module'
import { WorkspacePermissionsModule } from './workspace-permissions.module'
import { WorkspaceEmojisModule } from '../workspace-emojis/workspace-emojis.module'
import { EmailInviteModule } from '../email-invite/email-invite.module'

@Module({
  imports: [
    UserProfileModule,
    ChannelModule,
    ChatModule,
    WorkspacePermissionsModule,
    WorkspaceEmojisModule,
    // forwardRef: WorkspaceService inject EmailInviteService để tạo row
    // `workspace_email_invites` (token UUID) khi admin/owner add member
    // bằng email. EmailInviteModule đã import WorkspaceModule thẳng
    // (cho WorkspaceService.findOne) → circular nếu không forwardRef.
    forwardRef(() => EmailInviteModule),
  ],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
