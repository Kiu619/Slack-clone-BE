import { AuthService } from './auth.service'

describe('AuthService logout', () => {
  it('revokes the access session when a stale refresh cookie cannot be decoded', async () => {
    const redis = {
      addAccessTokenToBlacklist: jest.fn().mockResolvedValue(undefined),
      addRefreshTokenToBlacklist: jest.fn().mockResolvedValue(undefined),
    }
    const sessions = { revoke: jest.fn().mockResolvedValue(undefined) }
    const jwt = {
      verify: jest.fn((token: string, options: { secret: string }) => {
        if (token === 'access' && options.secret === 'access-secret') {
          return { sid: 'session-1', jti: 'access-jti', exp: Math.ceil(Date.now() / 1000) + 60 }
        }
        throw new Error('expired')
      }),
    }
    const service = new AuthService(
      {} as never,
      redis as never,
      {} as never,
      jwt as never,
      { getOrThrow: () => 'access-secret' } as never,
      sessions as never,
    )

    await service.logoutUser('access', 'expired-refresh')

    expect(sessions.revoke).toHaveBeenCalledTimes(1)
    expect(sessions.revoke).toHaveBeenCalledWith('session-1')
    expect(redis.addRefreshTokenToBlacklist).not.toHaveBeenCalled()
  })

  it('deduplicates a session ID found in both tokens', async () => {
    const redis = {
      addAccessTokenToBlacklist: jest.fn().mockResolvedValue(undefined),
      addRefreshTokenToBlacklist: jest.fn().mockResolvedValue(undefined),
    }
    const sessions = { revoke: jest.fn().mockResolvedValue(undefined) }
    const jwt = {
      verify: jest.fn(() => ({ sid: 'session-1', jti: 'jti', exp: Math.ceil(Date.now() / 1000) + 60 })),
    }
    const service = new AuthService(
      {} as never,
      redis as never,
      {} as never,
      jwt as never,
      { getOrThrow: () => 'secret' } as never,
      sessions as never,
    )

    await service.logoutUser('access', 'refresh')

    expect(sessions.revoke).toHaveBeenCalledTimes(1)
    expect(sessions.revoke).toHaveBeenCalledWith('session-1')
  })
})
