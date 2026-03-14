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
import { MagicLinkSchema, type MagicLinkDto } from './dto/magic-link.dto'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private config: ConfigService,
  ) {}

  // ─── Google OAuth ─────────────────────────────────────────────────────────

  @Get('google')
  @UseGuards(GoogleOAuthGuard)
  googleAuth() {
    // Passport redirects to Google automatically
  }

  @Get('google/callback')
  @UseGuards(GoogleOAuthGuard)
  googleCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as {
      id: string
      email: string
      name?: string
      avatar?: string
      isAway?: boolean
    }
    const { accessToken, refreshToken } = this.authService.generateTokens(
      user.id,
      user.email,
      user.name,
      user.avatar,
      user.isAway,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)
    res.redirect(
      `${this.config.get('FRONTEND_URL')}/auth/callback?success=true`,
    )
  }

  // ─── GitHub OAuth ─────────────────────────────────────────────────────────

  @Get('github')
  @UseGuards(GithubOAuthGuard)
  githubAuth() {
    // Passport redirects to GitHub automatically
  }

  @Get('github/callback')
  @UseGuards(GithubOAuthGuard)
  githubCallback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as {
      id: string
      email: string
      name?: string
      avatar?: string
      isAway?: boolean
    }
    const { accessToken, refreshToken } = this.authService.generateTokens(
      user.id,
      user.email,
      user.name,
      user.avatar,
      user.isAway,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)
    res.redirect(
      `${this.config.get('FRONTEND_URL')}/auth/callback?success=true`,
    )
  }

  // ─── Magic Link ───────────────────────────────────────────────────────────

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
    @Body('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.authService.verifyMagicLink(token)
    const { accessToken, refreshToken } = this.authService.generateTokens(
      user.id,
      user.email,
      user.name,
      user.avatar,
      user.isAway,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        isAway: user.isAway,
      },
    }
  }

  // ─── Token Management ─────────────────────────────────────────────────────

  @Post('refresh')
  @UseGuards(JwtRefreshGuard)
  @HttpCode(HttpStatus.OK)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { userId, email, name, avatar, isAway } = req.user as {
      userId: string
      email: string
      name?: string
      avatar?: string
      isAway?: boolean
    }
    const { accessToken, refreshToken } = this.authService.generateTokens(
      userId,
      email,
      name,
      avatar,
      isAway,
    )
    this.authService.setTokenCookies(res, accessToken, refreshToken)
    return { message: 'Tokens refreshed' }
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    this.authService.clearTokenCookies(res)
    return { message: 'Logged out successfully' }
  }

  // ─── Current User ─────────────────────────────────────────────────────────

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@Req() req: Request) {
    return req.user
  }
}
