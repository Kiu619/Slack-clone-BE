import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'
import { RedisService } from '../../redis/redis.service'

export interface JwtPayload {
  sub: string
  email: string
  name?: string | null
  avatar?: string | null
  jti?: string
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private redis: RedisService,
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
    // Backward compat: token cũ không có jti → bỏ qua blacklist.
    if (payload.jti) {
      const blacklisted = await this.redis.isAccessTokenBlacklisted(payload.jti)
      if (blacklisted) {
        throw new UnauthorizedException('Token has been revoked')
      }
    }

    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name ?? null,
      avatar: payload.avatar ?? null,
    }
  }
}
