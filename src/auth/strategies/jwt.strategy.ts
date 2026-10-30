import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'
import { RedisService } from '../../redis/redis.service'
import { AuthSessionService } from '../auth-session.service'

export interface JwtPayload {
  sub: string
  email: string
  name?: string | null
  avatar?: string | null
  jti: string
  sid: string
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private redis: RedisService,
    private sessions: AuthSessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => (req?.cookies?.access_token as string) ?? null,
      ]),
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      ignoreExpiration: false,
    })
  }

  async validate(payload: JwtPayload) {
    if (!payload.sid || !payload.jti) {
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Session expired',
      })
    }
    await this.sessions.assertActive(payload.sid, payload.sub)
    const blacklisted = await this.redis.isAccessTokenBlacklisted(payload.jti)
    if (blacklisted) {
      throw new UnauthorizedException({
        code: 'TOKEN_REVOKED',
        message: 'Token has been revoked',
      })
    }

    return {
      id: payload.sub,
      sid: payload.sid,
      email: payload.email,
      name: payload.name ?? null,
      avatar: payload.avatar ?? null,
    }
  }
}
