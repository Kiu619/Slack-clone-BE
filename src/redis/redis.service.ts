import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'

interface ThrottlerStorageRecord {
  totalHits: number
  timeToExpire: number
  isBlocked: boolean
  timeToBlockExpire: number
}

interface ThrottlerStorage {
  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord>
}

interface InMemoryEntry {
  totalHits: number
  expiresAt: number
  blockExpiresAt: number
}

@Injectable()
export class RedisService implements OnModuleInit {
  private readonly logger = new Logger(RedisService.name)
  private _redis: Redis | null = null
  private redisAvailable = true
  private readonly redisCheckIntervalMs = 30000
  private readonly fallbackModeLimit = 10
  private fallbackModeSince: number | null = null

  private readonly memoryStorage = new Map<string, InMemoryEntry>()

  constructor(@InjectRedis() private readonly redis: Redis) {}

  onModuleInit() {
    this._redis = this.redis
    this.startHealthCheck()
  }

  getRedisInstance(): Redis | null {
    return this._redis
  }

  isInFallbackMode(): boolean {
    return !this.redisAvailable
  }

  getFallbackModeDurationMs(): number | null {
    if (!this.fallbackModeSince) return null
    return Date.now() - this.fallbackModeSince
  }

  getThrottlerStats(): { memoryEntries: number; isRedisAvailable: boolean } {
    return {
      memoryEntries: this.memoryStorage.size,
      isRedisAvailable: this.redisAvailable,
    }
  }

  private startHealthCheck() {
    setInterval(() => {
      if (!this._redis) return

      this._redis
        .ping()
        .then((result) => {
          if (result === 'PONG' && !this.redisAvailable) {
            this.logger.log('Redis connection restored. Exiting fallback mode.')
            this.redisAvailable = true
            this.fallbackModeSince = null
          }
        })
        .catch(() => {
          if (this.redisAvailable) {
            this.logger.warn('Redis unavailable. Entering fallback mode.')
            this.redisAvailable = false
            this.fallbackModeSince = Date.now()
          }
        })
    }, this.redisCheckIntervalMs)
  }

  getThrottlerStorage(): ThrottlerStorage {
    return {
      increment: async (
        key: string,
        ttl: number,
        limit: number,
        blockDuration: number,
        throttlerName: string,
      ): Promise<ThrottlerStorageRecord> => {
        if (this.redisAvailable && this._redis) {
          return this.incrementRedis(
            key,
            ttl,
            limit,
            blockDuration,
            throttlerName,
          )
        }
        return this.incrementMemory(
          key,
          ttl,
          limit,
          blockDuration,
          throttlerName,
        )
      },
    }
  }

  private async incrementRedis(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const fullKey = `throttler:${throttlerName}:${key}`

    const luaScript = `
      local key = KEYS[1]
      local ttl = tonumber(ARGV[1])
      local limit = tonumber(ARGV[2])
      local blockDuration = tonumber(ARGV[3])

      local totalHits = redis.call('INCR', key)
      local expiresAt = redis.call('GET', key .. ':expiresAt')

      if totalHits == 1 then
        redis.call('PEXPIRE', key, ttl)
        redis.call('SET', key .. ':expiresAt', tostring(ARGV[4] + ttl), 'PX', ttl)
      else
        expiresAt = tonumber(expiresAt)
      end

      local timeToExpire = 0
      if expiresAt then
        timeToExpire = math.max(0, expiresAt - ARGV[4])
      end

      local isBlocked = totalHits > limit
      local timeToBlockExpire = 0

      if isBlocked then
        local blockKey = key .. ':blocked'
        local blockedUntil = redis.call('GET', blockKey)
        if not blockedUntil then
          redis.call('SET', blockKey, tostring(ARGV[4] + blockDuration), 'PX', blockDuration)
          timeToBlockExpire = blockDuration
        else
          timeToBlockExpire = math.max(0, tonumber(blockedUntil) - ARGV[4])
        end
      end

      return {totalHits, timeToExpire, isBlocked and 1 or 0, timeToBlockExpire}
    `

    try {
      const result = (await this._redis!.eval(
        luaScript,
        1,
        fullKey,
        ttl,
        limit,
        blockDuration,
        Date.now(),
      )) as [number, number, number, number]

      return {
        totalHits: result[0],
        timeToExpire: result[1],
        isBlocked: result[2] === 1,
        timeToBlockExpire: result[3],
      }
    } catch (error) {
      this.logger.warn(`Redis error, falling back to memory: ${error}`)
      this.redisAvailable = false
      this.fallbackModeSince = Date.now()
      return this.incrementMemory(key, ttl, limit, blockDuration, throttlerName)
    }
  }

  private incrementMemory(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): ThrottlerStorageRecord {
    const fullKey = `${throttlerName}:${key}`
    const now = Date.now()
    const effectiveLimit = this.fallbackModeLimit

    let entry = this.memoryStorage.get(fullKey)

    if (!entry || entry.expiresAt <= now) {
      entry = {
        totalHits: 0,
        expiresAt: now + ttl,
        blockExpiresAt: 0,
      }
    }

    entry.totalHits++

    const timeToExpire = Math.max(0, entry.expiresAt - now)
    const isBlocked = entry.totalHits > effectiveLimit
    let timeToBlockExpire = 0

    if (isBlocked) {
      if (entry.blockExpiresAt <= now) {
        entry.blockExpiresAt = now + blockDuration
        timeToBlockExpire = blockDuration
      } else {
        timeToBlockExpire = entry.blockExpiresAt - now
      }
    }

    this.memoryStorage.set(fullKey, entry)

    if (this.redisAvailable) {
      this.cleanupExpiredEntries(now)
    }

    return {
      totalHits: entry.totalHits,
      timeToExpire,
      isBlocked,
      timeToBlockExpire,
    }
  }

  private cleanupExpiredEntries(now: number) {
    for (const [key, entry] of this.memoryStorage.entries()) {
      if (entry.expiresAt <= now && entry.blockExpiresAt <= now) {
        this.memoryStorage.delete(key)
      }
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.setex(key, ttlSeconds, value)
    } else {
      await this.redis.set(key, value)
    }
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key)
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key)
    return result === 1
  }

  /**
   * Set value only if key doesn't exist (atomic).
   * Returns true if set successfully, false if key already exists.
   * @param key - Redis key
   * @param value - Value to set
   * @param ttlSeconds - TTL in seconds
   */
  async setNX(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')
    return result === 'OK'
  }

  /**
   * Create Redis clients for Socket.io Redis Adapter.
   * Returns { pubClient, subClient } - both connected to same Redis instance.
   * Caller is responsible for cleanup.
   */
  createRedisAdapterClients(): { pubClient: Redis; subClient: Redis } {
    const config = this.redis.options as Record<string, unknown>
    const url = config.url as string | undefined

    const pubClient = url
      ? new Redis(url)
      : new Redis({
          host: config.host as string,
          port: config.port as number,
          password: config.password as string | undefined,
          username: config.username as string | undefined,
          tls: config.tls as Record<string, unknown> | undefined,
        })

    const subClient = pubClient.duplicate()

    return { pubClient, subClient }
  }
}
