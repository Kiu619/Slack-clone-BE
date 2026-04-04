import { Module } from '@nestjs/common'
import { WorkspaceController } from './workspace.controller'
import { WorkspaceService } from './workspace.service'
import { UserProfileModule } from '../user-profile/user-profile.module'

@Module({
  imports: [UserProfileModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
