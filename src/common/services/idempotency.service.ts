import { Injectable, Logger } from '@nestjs/common'
import { RedisService } from '../../redis/redis.service'

export interface IdempotencyRecord {
  status: 'pending' | 'completed'
  response?: unknown
  createdAt: number
}

const DEFAULT_TTL_SECONDS = 300 // 5 minutes

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name)

  constructor(private readonly redisService: RedisService) {}

  /**
   * Check if an idempotency key exists and get its record.
   * @param key The idempotency key
   * @returns The record if exists, null otherwise
   */
  async getRecord(key: string): Promise<IdempotencyRecord | null> {
    try {
      const data = await this.redisService.get(`idempotency:${key}`)
      if (!data) return null
      return JSON.parse(data) as IdempotencyRecord
    } catch (error) {
      this.logger.warn(
        `Failed to get idempotency record for key ${key}: ${error}`,
      )
      return null
    }
  }

  /**
   * Try to acquire a lock for the idempotency key.
   * Returns false if key already exists (another request is processing).
   * @param key The idempotency key
   * @param ttlSeconds TTL in seconds (default: 300)
   * @returns true if lock acquired, false if key exists
   */
  async acquireLock(
    key: string,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<boolean> {
    try {
      const record: IdempotencyRecord = {
        status: 'pending',
        createdAt: Date.now(),
      }
      return await this.redisService.setNX(
        `idempotency:${key}`,
        JSON.stringify(record),
        ttlSeconds,
      )
    } catch (error) {
      this.logger.warn(
        `Failed to acquire idempotency lock for key ${key}: ${error}`,
      )
      return false
    }
  }

  /**
   * Store the response for an idempotency key.
   * @param key The idempotency key
   * @param response The response to store
   * @param ttlSeconds TTL in seconds (default: 300)
   */
  async storeResponse(
    key: string,
    response: unknown,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    try {
      const record: IdempotencyRecord = {
        status: 'completed',
        response,
        createdAt: Date.now(),
      }
      await this.redisService.set(
        `idempotency:${key}`,
        JSON.stringify(record),
        ttlSeconds,
      )
    } catch (error) {
      this.logger.warn(
        `Failed to store idempotency response for key ${key}: ${error}`,
      )
    }
  }

  /**
   * Store a pending record with updated TTL (useful when starting a long operation).
   * @param key The idempotency key
   * @param ttlSeconds TTL in seconds
   */
  async extendLock(
    key: string,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ): Promise<void> {
    try {
      const existing = await this.getRecord(key)
      if (existing) {
        await this.redisService.set(
          `idempotency:${key}`,
          JSON.stringify(existing),
          ttlSeconds,
        )
      }
    } catch (error) {
      this.logger.warn(
        `Failed to extend idempotency lock for key ${key}: ${error}`,
      )
    }
  }

  /**
   * Delete an idempotency key (for cleanup or error recovery).
   * @param key The idempotency key
   */
  async deleteKey(key: string): Promise<void> {
    try {
      await this.redisService.del(`idempotency:${key}`)
    } catch (error) {
      this.logger.warn(`Failed to delete idempotency key ${key}: ${error}`)
    }
  }
}
