import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { ConfigService } from '@nestjs/config'
import { AuthService } from './auth.service'
import { GoogleOAuthGuard } from './guards/google-oauth.guard'
import { GithubOAuthGuard } from './guards/github-oauth.guard'
import { JwtAuthGuard } from './guards/jwt-auth.guard'
import { JwtRefreshGuard } from './guards/jwt-refresh.guard'
import {
  MagicLinkSchema,
  MagicLinkVerifySchema,
  type MagicLinkDto,
  type MagicLinkVerifyDto,
} from './dto/magic-link.dto'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private config: ConfigService,
  ) {}

  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  googleAuth() {}

  @Get('google/callback')
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
    res.redirect(
      `${this.config.get('FRONTEND_URL')}/auth/callback?success=true`,
    )
  }

  @Get('github')
  @UseGuards(GithubOAuthGuard)
  githubAuth() {}

  @Get('github/callback')
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
    res.redirect(
      `${this.config.get('FRONTEND_URL')}/auth/callback?success=true`,
    )
  }

  @Post('magic-link/send')
  @HttpCode(HttpStatus.OK)
  async sendMagicLink(
    @Body(new ZodValidationPipe(MagicLinkSchema)) dto: MagicLinkDto,
  ) {
    await this.authService.sendMagicLink(dto.email)
    return { message: 'Magic link sent to your email' }
  }

  @Post('magic-link/verify')
  @HttpCode(HttpStatus.OK)
  async verifyMagicLink(
    @Body(new ZodValidationPipe(MagicLinkVerifySchema)) dto: MagicLinkVerifyDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.authService.verifyMagicLink(dto.token)
    const { accessToken, refreshToken } = this.authService.generateTokens(
      user.id,
      user.email,
      user.name,
      user.avatar,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)
    const account = await this.authService.getAccountById(user.id)
    return { user: account }
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
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  signOut(@Res({ passthrough: true }) res: Response) {
    this.authService.clearTokenCookies(res)
    return { message: 'Signed out successfully' }
  }

  /** Chỉ thông tin tài khoản (email, default name/avatar). Profile workspace: `GET user-profile/me?workspaceId=` */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    const account = await this.authService.getAccountById(userId)
    if (!account) return null
    return account
  }
}
