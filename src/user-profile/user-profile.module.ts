import { forwardRef, Module } from '@nestjs/common'
import { UserProfileController } from './user-profile.controller'
import { UserProfileService } from './user-profile.service'
import { UserProfileBroadcastService } from './user-profile-broadcast.service'
import { JwtModule } from '@nestjs/jwt'
import { ChatModule } from '../chat/chat.module'
import { WorkspacePermissionsModule } from '../workspace/workspace-permissions.module'

@Module({
  imports: [
    JwtModule,
    forwardRef(() => ChatModule),
    WorkspacePermissionsModule,
  ],
  controllers: [UserProfileController],
  providers: [UserProfileService, UserProfileBroadcastService],
  exports: [UserProfileService, UserProfileBroadcastService],
})
export class UserProfileModule {}
