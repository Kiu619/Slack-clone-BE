import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Request, Response } from 'express'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { EmailInviteService } from './email-invite.service'
import { AcceptInviteSchema, type AcceptInviteDto } from './dto/accept-invite.dto'
import { VerifyOtpSchema, type VerifyOtpDto } from './dto/verify-otp.dto'
import { SendOtpSchema } from './dto/send-otp.dto'
import { Public } from '../auth/decorators/public.decorator'
interface AuthedRequest extends Request {
  user?: {
    id: string
    email: string
    name?: string | null
    avatar?: string | null
  }
}

@Controller('invites')
export class EmailInviteController {
  constructor(
    private readonly invites: EmailInviteService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Dev-only: trả về raw OTP code cho 1 invite. Chỉ hoạt động khi
   * NODE_ENV !== 'production' — để E2E test đọc mã mà không cần mailbox.
   *
   * Không thuộc public API.
   */
  @Get('dev/otp/:inviteId')
  @Public()
  @HttpCode(HttpStatus.OK)
  async devGetOtp(@Param('inviteId') inviteId: string) {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error('Dev endpoint not available in production')
    }
    return this.invites.devGetRawOtp(inviteId)
  }

  @Get(':token')
  @Public()
  async getByToken(@Param('token') token: string) {
    const info = await this.invites.getByToken(token)
    if (!info) {
      // Không throw 404 ở đây — FE cần biết phân biệt "not found" và
      // "accepted"/"expired" để hiển thị UI tương ứng. Trả null + cờ.
      return { found: false as const }
    }
    return { found: true as const, ...info }
  }

  @Post(':token/send-otp')
  @Public()
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Param('token') token: string) {
    void SendOtpSchema // validation placeholder
    return this.invites.sendOtp(token)
  }

  @Post(':token/verify-otp')
  @Public()
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(VerifyOtpSchema)) body: VerifyOtpDto,
  ) {
    return this.invites.verifyOtp(token, body.code)
  }

  /**
   * Accept invite:
   *   - method='otp': optional auth (BE tự tạo user nếu chưa có).
   *   - method='oauth': yêu cầu JWT (user đã OAuth).
   *
   * Controller không bắt buộc JwtAuthGuard vì nhánh OTP có thể chưa đăng nhập.
   * Service sẽ tự resolve user từ body + optional `req.user`.
   */
  @Post(':token/accept')
  @Public()
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(AcceptInviteSchema)) body: AcceptInviteDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.invites.acceptInvite(
      token,
      body,
      req.user ?? null,
      res,
    )
  }
}
