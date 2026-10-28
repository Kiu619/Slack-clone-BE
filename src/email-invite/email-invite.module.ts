import { Module, forwardRef } from '@nestjs/common'
import { EmailInviteController } from './email-invite.controller'
import { EmailInviteService } from './email-invite.service'
import { AuthModule } from '../auth/auth.module'
import { WorkspaceModule } from '../workspace/workspace.module'

@Module({
  // forwardRef: EmailInviteService inject AuthService (qua AuthModule) để
  // set JWT cookies khi accept nhánh OTP. AuthController inject
  // EmailInviteService để set/clear cookie `pending_invite_token` ở
  // OAuth init/callback → circular nếu không forwardRef.
  imports: [forwardRef(() => AuthModule), WorkspaceModule],
  controllers: [EmailInviteController],
  providers: [EmailInviteService],
  exports: [EmailInviteService],
})
export class EmailInviteModule {}
