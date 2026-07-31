import { Injectable, Logger } from '@nestjs/common'
import { RedisPresenceService } from './redis-presence.service'

type WorkspaceUserPresence = {
  socketCount: number
}

@Injectable()
export class WorkspacePresenceService {
  private readonly logger = new Logger(WorkspacePresenceService.name)

  /**
   * In-memory fallback storage when Redis is unavailable.
   * Same structure as before for backward compatibility.
   */
  private readonly workspaceUsers = new Map<
    string,
    Map<string, WorkspaceUserPresence>
  >()
  private readonly socketWorkspaces = new Map<string, Set<string>>()

  constructor(
    private readonly redisPresenceService: RedisPresenceService,
  ) {}

  markWorkspaceJoined(socketId: string, workspaceId: string, userId: string) {
    if (!workspaceId || !userId) return

    const workspaceMap = this.getOrCreateWorkspaceMap(workspaceId)
    const socketSet = this.socketWorkspaces.get(socketId) ?? new Set<string>()

    // Một socket chỉ nên được tính online 1 lần cho cùng workspace.
    // Nếu client emit `join-workspace` trùng từ nhiều hook, bỏ qua để tránh cộng socketCount sai.
    if (socketSet.has(workspaceId)) {
      this.socketWorkspaces.set(socketId, socketSet)
      return
    }

    const entry = workspaceMap.get(userId) ?? { socketCount: 0 }
    entry.socketCount += 1
    workspaceMap.set(userId, entry)

    socketSet.add(workspaceId)
    this.socketWorkspaces.set(socketId, socketSet)

    // Sync to Redis for cross-worker visibility
    this.redisPresenceService.markJoined(workspaceId, userId, socketId).catch((error) => {
      this.logger.warn(`Failed to sync presence to Redis: ${error}`)
    })
  }

  markWorkspaceLeft(socketId: string, workspaceId: string, userId: string) {
    if (!workspaceId || !userId) return

    this.decrementPresence(workspaceId, userId)

    const socketSet = this.socketWorkspaces.get(socketId)
    if (!socketSet) return
    socketSet.delete(workspaceId)
    if (socketSet.size === 0) {
      this.socketWorkspaces.delete(socketId)
    }

    // Sync to Redis for cross-worker visibility
    this.redisPresenceService.markLeft(workspaceId, userId, socketId).catch((error) => {
      this.logger.warn(`Failed to sync presence to Redis: ${error}`)
    })
  }

  markSocketDisconnected(socketId: string, userId: string) {
    const workspaceIds = this.socketWorkspaces.get(socketId)
    if (!workspaceIds || workspaceIds.size === 0) {
      this.socketWorkspaces.delete(socketId)
      return [] as string[]
    }

    const affectedWorkspaceIds = Array.from(workspaceIds)
    for (const workspaceId of workspaceIds) {
      this.decrementPresence(workspaceId, userId)

      // Sync to Redis for cross-worker visibility
      this.redisPresenceService.markLeft(workspaceId, userId, socketId).catch((error) => {
        this.logger.warn(`Failed to sync presence to Redis: ${error}`)
      })
    }

    this.socketWorkspaces.delete(socketId)
    return affectedWorkspaceIds
  }

  /**
   * Socket-level presence only.
   * "Online" trong UI được tính riêng bằng socket connection + !isAway.
   */
  getConnectedUserIds(workspaceId: string, userIds: string[]) {
    const workspaceMap = this.workspaceUsers.get(workspaceId)
    if (!workspaceMap || userIds.length === 0) return []

    return userIds.filter(
      (userId) => (workspaceMap.get(userId)?.socketCount ?? 0) > 0,
    )
  }

  getOnlineUserIds(workspaceId: string, userIds: string[]) {
    return this.getConnectedUserIds(workspaceId, userIds)
  }

  getWorkspaceConnectedUserIds(workspaceId: string) {
    const workspaceMap = this.workspaceUsers.get(workspaceId)
    if (!workspaceMap || workspaceMap.size === 0) return []
    return Array.from(workspaceMap.entries())
      .filter(([, presence]) => presence.socketCount > 0)
      .map(([userId]) => userId)
  }

  getWorkspaceOnlineUserIds(workspaceId: string) {
    return this.getWorkspaceConnectedUserIds(workspaceId)
  }

  isUserOnline(workspaceId: string, userId: string) {
    return (
      (this.workspaceUsers.get(workspaceId)?.get(userId)?.socketCount ?? 0) > 0
    )
  }

  private getOrCreateWorkspaceMap(workspaceId: string) {
    const existing = this.workspaceUsers.get(workspaceId)
    if (existing) return existing
    const created = new Map<string, WorkspaceUserPresence>()
    this.workspaceUsers.set(workspaceId, created)
    return created
  }

  private decrementPresence(workspaceId: string, userId: string) {
    const workspaceMap = this.workspaceUsers.get(workspaceId)
    if (!workspaceMap) return

    const entry = workspaceMap.get(userId)
    if (!entry) return

    entry.socketCount -= 1
    if (entry.socketCount <= 0) {
      workspaceMap.delete(userId)
    } else {
      workspaceMap.set(userId, entry)
    }

    if (workspaceMap.size === 0) {
      this.workspaceUsers.delete(workspaceId)
    }
  }
}
