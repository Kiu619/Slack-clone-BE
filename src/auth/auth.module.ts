import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { GoogleStrategy } from './strategies/google.strategy'
import { GithubStrategy } from './strategies/github.strategy'
import { JwtStrategy } from './strategies/jwt.strategy'
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy'
import { WorkspaceMemberGuard } from './guards/workspace-member.guard'
import { WorkspacePermissionsModule } from '../workspace/workspace-permissions.module'

@Module({
  imports: [PassportModule, JwtModule.register({}), WorkspacePermissionsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    GoogleStrategy,
    GithubStrategy,
    JwtStrategy,
    JwtRefreshStrategy,
    WorkspaceMemberGuard,
  ],
  exports: [WorkspaceMemberGuard],
})
export class AuthModule {}
