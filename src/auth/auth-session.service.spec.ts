import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { AuthSessionService } from './auth-session.service'

type Session = { userId: string; tokenHash: string; expiresAt: number }

class FakeRedis {
  readonly values = new Map<string, string>()
  readonly published: Array<[string, string]> = []
  fail = false

  async set(key: string, value: string): Promise<'OK'> {
    this.assertAvailable()
    this.values.set(key, value)
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    this.assertAvailable()
    return this.values.get(key) ?? null
  }

  async del(key: string): Promise<number> {
    this.assertAvailable()
    return this.values.delete(key) ? 1 : 0
  }

  async publish(channel: string, value: string): Promise<number> {
    this.assertAvailable()
    this.published.push([channel, value])
    return 1
  }

  async eval(
    _script: string,
    _keyCount: number,
    sessionKey: string,
    graceKey: string,
    userId: string,
    oldHash: string,
    newHash: string,
    expiresAt: number,
    _ttlMs: number,
    result: string,
  ): Promise<number> {
    this.assertAvailable()
    const raw = this.values.get(sessionKey)
    if (!raw) return 0
    const session = JSON.parse(raw) as Session
    if (session.userId !== userId) return 0
    if (session.tokenHash !== oldHash) return 2
    this.values.set(
      sessionKey,
      JSON.stringify({ ...session, tokenHash: newHash, expiresAt }),
    )
    this.values.set(graceKey, result)
    return 1
  }

  private assertAvailable() {
    if (this.fail) throw new Error('Redis unavailable')
  }
}

describe('AuthSessionService', () => {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'AUTH_ACCESS_TTL_SECONDS') return 900
      if (key === 'AUTH_REFRESH_TTL_SECONDS') return 2_592_000
      if (key === 'AUTH_ROTATE_WINDOW_SECONDS') return 86_400
      return undefined
    }),
  }
  let redis: FakeRedis
  let service: AuthSessionService

  beforeEach(() => {
    redis = new FakeRedis()
    service = new AuthSessionService(
      { getRedisInstance: () => redis } as never,
      config as never,
    )
  })

  it('creates a hashed session and never stores the raw refresh token', async () => {
    await service.create('user-1', 'raw-refresh', 'session-1')

    const raw = redis.values.get('auth:session:session-1')
    expect(raw).toBeDefined()
    expect(raw).not.toContain('raw-refresh')
    expect((JSON.parse(raw!) as Session).tokenHash).toBe(
      service.hash('raw-refresh'),
    )
  })

  it('rotates once and exposes the same result to a concurrent old token', async () => {
    await service.create('user-1', 'old-refresh', 'session-1')

    await expect(
      service.rotate(
        'session-1',
        'user-1',
        'old-refresh',
        'new-access',
        'new-refresh',
      ),
    ).resolves.toBe('rotated')

    await expect(
      service.rotate(
        'session-1',
        'user-1',
        'old-refresh',
        'other-access',
        'other-refresh',
      ),
    ).resolves.toBe('stale')
    await expect(
      service.getGrace('session-1', service.hash('old-refresh')),
    ).resolves.toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    })
  })

  it('reports a replaced token as stale after its grace result is gone', async () => {
    await service.create('user-1', 'old-refresh', 'session-1')
    await service.rotate(
      'session-1',
      'user-1',
      'old-refresh',
      'new-access',
      'new-refresh',
    )
    redis.values.delete(
      `auth:rotation:session-1:${service.hash('old-refresh')}`,
    )

    await expect(
      service.rotate(
        'session-1',
        'user-1',
        'old-refresh',
        'replay-access',
        'replay-refresh',
      ),
    ).resolves.toBe('stale')
    await expect(
      service.getGrace('session-1', service.hash('old-refresh')),
    ).resolves.toBeNull()
  })

  it('rejects missing, expired, or wrong-user sessions', async () => {
    await expect(service.assertActive('missing', 'user-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    redis.values.set(
      'auth:session:expired',
      JSON.stringify({
        userId: 'user-1',
        tokenHash: service.hash('refresh'),
        expiresAt: Date.now() - 1,
      }),
    )
    await expect(service.assertActive('expired', 'user-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('fails closed when Redis cannot verify session state', async () => {
    redis.fail = true
    await expect(service.get('session-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    )
  })

  it('revokes idempotently and broadcasts each revoke request', async () => {
    await service.create('user-1', 'refresh', 'session-1')
    await service.revoke('session-1')
    await service.revoke('session-1')

    expect(redis.values.has('auth:session:session-1')).toBe(false)
    expect(redis.published).toEqual([
      ['auth:session-revoked', 'session-1'],
      ['auth:session-revoked', 'session-1'],
    ])
  })
})
