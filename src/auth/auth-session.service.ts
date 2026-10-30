import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash, randomUUID } from 'crypto'
import { RedisService } from '../redis/redis.service'

export interface AuthSession {
  userId: string
  tokenHash: string
  expiresAt: number
}

const rotateScript = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local session = cjson.decode(current)
if session.userId ~= ARGV[1] then return 0 end
if session.tokenHash ~= ARGV[2] then return 2 end
session.tokenHash = ARGV[3]
session.expiresAt = tonumber(ARGV[4])
redis.call('SET', KEYS[1], cjson.encode(session), 'PX', ARGV[5])
redis.call('SET', KEYS[2], ARGV[6], 'EX', 10)
return 1
`

@Injectable()
export class AuthSessionService {
  constructor(private readonly redis: RedisService, private readonly config: ConfigService) {}

  get refreshSeconds(): number {
    return Number(this.config.get('AUTH_REFRESH_TTL_SECONDS') ?? 30 * 24 * 3600)
  }

  get accessSeconds(): number {
    return Number(this.config.get('AUTH_ACCESS_TTL_SECONDS') ?? 15 * 60)
  }

  get rotateWindowSeconds(): number {
    return Number(this.config.get('AUTH_ROTATE_WINDOW_SECONDS') ?? 24 * 3600)
  }

  get socketRevalidationSeconds(): number {
    return Number(this.config.get('AUTH_SOCKET_REVALIDATION_SECONDS') ?? 60)
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private key(sid: string): string { return `auth:session:${sid}` }
  private graceKey(sid: string, tokenHash: string): string { return `auth:rotation:${sid}:${tokenHash}` }

  async create(userId: string, refreshToken: string, sid: string): Promise<void> {
    const session: AuthSession = {
      userId,
      tokenHash: this.hash(refreshToken),
      expiresAt: Date.now() + this.refreshSeconds * 1000,
    }
    try {
      await this.redis.getRedisInstance()!.set(this.key(sid), JSON.stringify(session), 'EX', this.refreshSeconds)
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTH_STORE_UNAVAILABLE',
        message: 'Authentication store unavailable',
      })
    }
  }

  async get(sid: string): Promise<AuthSession | null> {
    try {
      const value = await this.redis.getRedisInstance()!.get(this.key(sid))
      if (!value) return null
      const session = JSON.parse(value) as AuthSession
      if (session.expiresAt <= Date.now()) return null
      return session
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTH_STORE_UNAVAILABLE',
        message: 'Authentication store unavailable',
      })
    }
  }

  async assertActive(sid: string, userId: string): Promise<AuthSession> {
    const session = await this.get(sid)
    if (!session || session.userId !== userId) {
      throw new UnauthorizedException({ code: 'SESSION_EXPIRED', message: 'Session expired' })
    }
    return session
  }

  async getGrace(sid: string, oldHash: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    try {
      const raw = await this.redis.getRedisInstance()!.get(this.graceKey(sid, oldHash))
      return raw ? JSON.parse(raw) as { accessToken: string; refreshToken: string } : null
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTH_STORE_UNAVAILABLE',
        message: 'Authentication store unavailable',
      })
    }
  }

  async rotate(sid: string, userId: string, oldToken: string, accessToken: string, refreshToken: string): Promise<'rotated' | 'stale' | 'expired'> {
    const oldHash = this.hash(oldToken)
    const ttlMs = this.refreshSeconds * 1000
    try {
      const result = await this.redis.getRedisInstance()!.eval(
        rotateScript, 2, this.key(sid), this.graceKey(sid, oldHash),
        userId, oldHash, this.hash(refreshToken), Date.now() + ttlMs, ttlMs,
        JSON.stringify({ accessToken, refreshToken }),
      ) as number
      return result === 1 ? 'rotated' : result === 2 ? 'stale' : 'expired'
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTH_STORE_UNAVAILABLE',
        message: 'Authentication store unavailable',
      })
    }
  }

  async revoke(sid: string): Promise<void> {
    try {
      await this.redis.getRedisInstance()!.del(this.key(sid))
      await this.redis.getRedisInstance()!.publish('auth:session-revoked', sid)
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTH_STORE_UNAVAILABLE',
        message: 'Authentication store unavailable',
      })
    }
  }

  newId(): string { return randomUUID() }
}
