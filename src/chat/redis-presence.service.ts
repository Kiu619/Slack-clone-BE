import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import { RedisService } from '../redis/redis.service'
import Redis from 'ioredis'

/**
 * Redis-backed presence service for cross-worker presence tracking.
 * Uses Redis Hash to store presence data shared across all workers.
 *
 * Key format: presence:{workspaceId}
 * Value: Redis Hash { userId: socketCount, ... }
 *
 * Also subscribes to presence change events for real-time updates.
 */
@Injectable()
export class RedisPresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPresenceService.name)
  private subscriber: Redis | null = null
  private readonly PUBSUB_CHANNEL = 'presence:changes'
  private handlers = new Map<string, Set<(data: PresenceChangeEvent) => void>>()

  constructor(private readonly redisService: RedisService) {}

  async onModuleInit() {
    // Subscribe to presence change events from other workers
    const { pubClient } = this.redisService.createRedisAdapterClients()
    this.subscriber = pubClient.duplicate()

    await this.subscriber.subscribe(this.PUBSUB_CHANNEL)
    this.logger.log('Subscribed to presence changes channel')

    this.subscriber.on('message', (channel, message) => {
      if (channel === this.PUBSUB_CHANNEL) {
        try {
          const event: PresenceChangeEvent = JSON.parse(message)
          this.notifyHandlers(event)
        } catch (error) {
          this.logger.warn(`Failed to parse presence event: ${error}`)
        }
      }
    })
  }

  async onModuleDestroy() {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(this.PUBSUB_CHANNEL)
      await this.subscriber.quit()
      this.subscriber = null
    }
  }

  /**
   * Record that a user has joined a workspace (connected a socket).
   */
  async markJoined(
    workspaceId: string,
    userId: string,
    socketId: string,
  ): Promise<void> {
    const redis = this.redisService.getRedisInstance()
    if (!redis) return

    const key = this.getKey(workspaceId)

    try {
      // Increment user's socket count
      await redis.hincrby(key, userId, 1)

      // Publish change event for other workers
      await this.publishChange({
        type: 'joined',
        workspaceId,
        userId,
        socketCount: 1, // Will be calculated by client
      })
    } catch (error) {
      this.logger.warn(`Failed to mark joined: ${error}`)
    }
  }

  /**
   * Record that a user has left a workspace (disconnected a socket).
   */
  async markLeft(
    workspaceId: string,
    userId: string,
    socketId: string,
  ): Promise<void> {
    const redis = this.redisService.getRedisInstance()
    if (!redis) return

    const key = this.getKey(workspaceId)

    try {
      // Decrement user's socket count
      const newCount = await redis.hincrby(key, userId, -1)

      // If count is 0 or negative, remove the user from hash
      if (newCount <= 0) {
        await redis.hdel(key, userId)
      }

      // Publish change event for other workers
      await this.publishChange({
        type: newCount <= 0 ? 'left' : 'joined',
        workspaceId,
        userId,
        socketCount: Math.max(0, newCount),
      })
    } catch (error) {
      this.logger.warn(`Failed to mark left: ${error}`)
    }
  }

  /**
   * Get all online user IDs in a workspace.
   */
  async getOnlineUserIds(workspaceId: string): Promise<string[]> {
    const redis = this.redisService.getRedisInstance()
    if (!redis) return []

    const key = this.getKey(workspaceId)

    try {
      const entries = await redis.hgetall(key)
      // Filter out users with 0 count (shouldn't happen but be safe)
      return Object.entries(entries)
        .filter(([, count]) => parseInt(count, 10) > 0)
        .map(([userId]) => userId)
    } catch (error) {
      this.logger.warn(`Failed to get online users: ${error}`)
      return []
    }
  }

  /**
   * Check if a user is online in a workspace.
   */
  async isOnline(workspaceId: string, userId: string): Promise<boolean> {
    const redis = this.redisService.getRedisInstance()
    if (!redis) return false

    const key = this.getKey(workspaceId)

    try {
      const count = await redis.hget(key, userId)
      return parseInt(count ?? '0', 10) > 0
    } catch (error) {
      this.logger.warn(`Failed to check online status: ${error}`)
      return false
    }
  }

  /**
   * Get socket count for a user in a workspace.
   */
  async getSocketCount(
    workspaceId: string,
    userId: string,
  ): Promise<number> {
    const redis = this.redisService.getRedisInstance()
    if (!redis) return 0

    const key = this.getKey(workspaceId)

    try {
      const count = await redis.hget(key, userId)
      return parseInt(count ?? '0', 10)
    } catch (error) {
      this.logger.warn(`Failed to get socket count: ${error}`)
      return 0
    }
  }

  /**
   * Subscribe to presence changes for a workspace.
   */
  onPresenceChange(
    workspaceId: string,
    handler: (data: PresenceChangeEvent) => void,
  ): () => void {
    const key = `workspace:${workspaceId}`
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set())
    }
    this.handlers.get(key)!.add(handler)

    // Return unsubscribe function
    return () => {
      this.handlers.get(key)?.delete(handler)
    }
  }

  private async publishChange(event: PresenceChangeEvent): Promise<void> {
    const redis = this.redisService.getRedisInstance()
    if (!redis) return

    try {
      await redis.publish(this.PUBSUB_CHANNEL, JSON.stringify(event))
    } catch (error) {
      this.logger.warn(`Failed to publish presence change: ${error}`)
    }
  }

  private notifyHandlers(event: PresenceChangeEvent): void {
    const key = `workspace:${event.workspaceId}`
    const handlers = this.handlers.get(key)
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(event)
        } catch (error) {
          this.logger.warn(`Handler error: ${error}`)
        }
      })
    }
  }

  private getKey(workspaceId: string): string {
    return `presence:${workspaceId}`
  }
}

export interface PresenceChangeEvent {
  type: 'joined' | 'left'
  workspaceId: string
  userId: string
  socketCount: number
}
