/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'
import { AuthService } from '../auth.service'
import { AuthSessionService } from '../auth-session.service'
import { RedisService } from '../../redis/redis.service'

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(
    config: ConfigService,
    private authService: AuthService,
    private sessions: AuthSessionService,
    private redis: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.refresh_token ?? null,
      ]),
      secretOrKey: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      ignoreExpiration: false,
      passReqToCallback: true,
    })
  }

  async validate(
    req: Request,
    payload: { sub: string; email: string; sid: string; jti: string },
  ) {
    if (!payload.sid || !payload.jti) {
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Session expired',
      })
    }
    const rawToken = req.cookies?.['refresh_token'] as string | undefined
    if (!rawToken || await this.redis.isRefreshTokenBlacklisted(rawToken)) {
      throw new UnauthorizedException({
        code: 'TOKEN_REVOKED',
        message: 'Refresh token has been revoked',
      })
    }
    await this.sessions.assertActive(payload.sid, payload.sub)

    const user = await this.authService.getAccountById(payload.sub)
    if (!user) throw new UnauthorizedException()
    return {
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      avatar: user.avatar ?? null,
    }
  }
}
