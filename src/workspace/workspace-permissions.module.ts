import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { WorkspacePermissionsService } from './workspace-permissions.service'

@Module({
  imports: [DatabaseModule],
  providers: [WorkspacePermissionsService],
  exports: [WorkspacePermissionsService],
})
export class WorkspacePermissionsModule {}
