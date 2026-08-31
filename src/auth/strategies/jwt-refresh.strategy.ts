/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'
import { AuthService } from '../auth.service'
import { RedisService } from '../../redis/redis.service'

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(
    config: ConfigService,
    private authService: AuthService,
    private redis: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.refresh_token ?? null,
      ]),
      secretOrKey: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      ignoreExpiration: false,
    })
  }

  authenticate(req: Request) {
    // Store raw token so validate() can access it for blacklist check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this as any)._rawRefreshToken =
      (req?.cookies?.refresh_token as string) ?? ''
    return super.authenticate(req)
  }

  async validate(payload: { sub: string; email: string }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawToken = (this as any)._rawRefreshToken as string | undefined
    if (rawToken) {
      const blacklisted = await this.redis.isRefreshTokenBlacklisted(rawToken)
      if (blacklisted) {
        throw new UnauthorizedException('Refresh token has been revoked')
      }
    }

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
