import { Module, forwardRef } from '@nestjs/common'
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
import { EmailInviteModule } from '../email-invite/email-invite.module'

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
    WorkspacePermissionsModule,
    // forwardRef: tránh vòng lặp AuthModule ↔ EmailInviteModule.
    // AuthController inject EmailInviteService để set/clear cookie
    // `pending_invite_token` ở OAuth init/callback. EmailInviteService
    // inject AuthService (qua AuthModule) để set JWT cookies khi accept
    // qua nhánh OTP.
    forwardRef(() => EmailInviteModule),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    GoogleStrategy,
    GithubStrategy,
    JwtStrategy,
    JwtRefreshStrategy,
    WorkspaceMemberGuard,
  ],
  exports: [WorkspaceMemberGuard, AuthService],
})
export class AuthModule {}
