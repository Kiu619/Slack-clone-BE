import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Request, Response } from 'express'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { SkipWorkspaceMemberCheck } from './decorators/skip-workspace-member-check.decorator';
import {
    MagicLinkSchema,
    MagicLinkVerifySchema,
    type MagicLinkDto,
    type MagicLinkVerifyDto,
} from './dto/magic-link.dto';
import { GithubOAuthGuard } from './guards/github-oauth.guard';
import { GoogleOAuthGuard } from './guards/google-oauth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private config: ConfigService,
  ) {}

  @Post('google/init')
  @Public()
  @SkipWorkspaceMemberCheck()
  @HttpCode(HttpStatus.OK)
  initGoogle(
    @Body() body: { redirect?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const redirect = this.authService.sanitizeRedirectPath(body?.redirect)
    this.authService.setOAuthRedirectCookie(res, redirect)
    return { ok: true }
  }

  @Post('github/init')
  @Public()
  @SkipWorkspaceMemberCheck()
  @HttpCode(HttpStatus.OK)
  initGithub(
    @Body() body: { redirect?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const redirect = this.authService.sanitizeRedirectPath(body?.redirect)
    this.authService.setOAuthRedirectCookie(res, redirect)
    return { ok: true }
  }

  @Get('google')
  @Public()
  @SkipWorkspaceMemberCheck()
  @UseGuards(GoogleOAuthGuard)
  googleAuth() {}

  @Get('google/callback')
  @Public()
  @SkipWorkspaceMemberCheck()
  @UseGuards(GoogleOAuthGuard)
  googleCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as {
      id: string
      email: string
      name?: string
      avatar?: string
    }
    const { accessToken, refreshToken } = this.authService.generateTokens(
      user.id,
      user.email,
      user.name,
      user.avatar,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)

    const redirect = this.authService.readOAuthRedirectCookie(req)
    this.authService.clearOAuthRedirectCookie(res)

    const params = new URLSearchParams({ success: 'true' })
    if (redirect) params.set('redirect', redirect)
    res.redirect(`${this.config.get('FRONTEND_URL')}/auth/callback?${params}`)
  }

  @Get('github')
  @Public()
  @SkipWorkspaceMemberCheck()
  @UseGuards(GithubOAuthGuard)
  githubAuth() {}

  @Get('github/callback')
  @Public()
  @SkipWorkspaceMemberCheck()
  @UseGuards(GithubOAuthGuard)
  githubCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as {
      id: string
      email: string
      name?: string
      avatar?: string
    }
    const { accessToken, refreshToken } = this.authService.generateTokens(
      user.id,
      user.email,
      user.name,
      user.avatar,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)

    const redirect = this.authService.readOAuthRedirectCookie(req)
    this.authService.clearOAuthRedirectCookie(res)

    const params = new URLSearchParams({ success: 'true' })
    if (redirect) params.set('redirect', redirect)
    res.redirect(`${this.config.get('FRONTEND_URL')}/auth/callback?${params}`)
  }

  @Post('magic-link/send')
  @Public()
  @HttpCode(HttpStatus.OK)
  async sendMagicLink(
    @Body(new ZodValidationPipe(MagicLinkSchema)) dto: MagicLinkDto,
  ) {
    await this.authService.sendMagicLink(dto.email, dto.redirect ?? undefined)
    return { message: 'Magic link sent to your email' }
  }

  @Post('magic-link/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  async verifyMagicLink(
    @Body(new ZodValidationPipe(MagicLinkVerifySchema)) dto: MagicLinkVerifyDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, redirect } = await this.authService.verifyMagicLink(dto.token)
    const { accessToken, refreshToken } = this.authService.generateTokens(
      user.id,
      user.email,
      user.name,
      user.avatar,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)
    const account = await this.authService.getAccountById(user.id)
    return { user: account, redirect }
  }

  @Post('refresh')
  @UseGuards(JwtRefreshGuard)
  @HttpCode(HttpStatus.OK)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { id, email, name, avatar } = req.user as {
      id: string
      email: string
      name?: string | null
      avatar?: string | null
    }
    const { accessToken, refreshToken } = this.authService.generateTokens(
      id,
      email,
      name,
      avatar,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)
    return { message: 'Tokens refreshed' }
  }

  @Post('sign-out')
  @HttpCode(HttpStatus.OK)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const accessToken = req.cookies?.['access_token'] as string | undefined
    const refreshToken = req.cookies?.['refresh_token'] as string | undefined
    await this.authService.logoutUser(accessToken, refreshToken)
    this.authService.clearTokenCookies(res)
    return { message: 'Signed out successfully' }
  }

  /** Chỉ thông tin tài khoản (email, default name/avatar). Profile workspace: `GET user-profile/me?workspaceId=` */
  @Get('me')
  async getMe(@Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    const account = await this.authService.getAccountById(userId)
    if (!account) return null
    return account
  }
}
