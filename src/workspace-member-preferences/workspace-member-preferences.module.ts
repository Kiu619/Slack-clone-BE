import { forwardRef, Module } from '@nestjs/common'
import { WorkspaceMemberPreferencesController } from './workspace-member-preferences.controller'
import { WorkspaceMemberPreferencesService } from './workspace-member-preferences.service'
import { WorkspaceModule } from '../workspace/workspace.module'

@Module({
  imports: [forwardRef(() => WorkspaceModule)],
  controllers: [WorkspaceMemberPreferencesController],
  providers: [WorkspaceMemberPreferencesService],
  exports: [WorkspaceMemberPreferencesService],
})
export class WorkspaceMemberPreferencesModule {}
