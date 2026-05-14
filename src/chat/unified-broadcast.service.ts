import { Injectable } from '@nestjs/common'
import { Server } from 'socket.io'

export enum EntityDomain {
  CHAT = 'CHAT',
  USER = 'USER',
  CHANNEL = 'CHANNEL',
  NOTIFICATION = 'NOTIFICATION',
}

export enum EntityAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  SYNC = 'SYNC',
}

export interface EntitySyncPayload {
  domain: EntityDomain
  action: EntityAction
  payload: {
    id: string
    data?: any
    workspaceId?: string
    channelId?: string
    conversationId?: string
    /** CHAT UPDATE — client invalidate tab Files */
    attachmentsChanged?: boolean
    deletedAttachmentId?: string
  }
}

@Injectable()
export class UnifiedBroadcastService {
  private server: Server | null = null

  setServer(server: Server) {
    // DEBUG: log namespace để xác nhận server đúng
    const nsName = (server as any).name ?? (server as any)._nsps ? '(io server)' : 'unknown'
    console.log(`[UnifiedBroadcast] setServer called - server namespace info:`, nsName)
    this.server = server
  }

  /**
   * syncEntity — Gửi sự kiện đồng bộ thực thể chuẩn hóa
   */
  syncEntity(
    target: {
      userId?: string
      channelId?: string
      conversationId?: string
      workspaceId?: string
      threadId?: string
    },
    syncPayload: EntitySyncPayload,
    excludeSocketId?: string,
  ) {
    if (!this.server) {
      console.log('[UnifiedBroadcast] syncEntity called but server is NULL!')
      return
    }

    const eventName = 'entity:sync'
    console.log(`[UnifiedBroadcast] syncEntity emitting '${eventName}' - domain:${syncPayload.domain} action:${syncPayload.action} target:`, JSON.stringify(target))

    // 1. Gửi tới Personal Room (Nếu có userId)
    if (target.userId && target.workspaceId) {
      console.log(`[UnifiedBroadcast]  -> room: user:${target.workspaceId}:${target.userId}`)
      let emitter = this.server.to(`user:${target.workspaceId}:${target.userId}`)
      if (excludeSocketId) emitter = emitter.except(excludeSocketId)
      emitter.emit(eventName, syncPayload)
    } else if (target.userId) {
      console.log(`[UnifiedBroadcast]  -> room: user:${target.userId}`)
      let emitter = this.server.to(`user:${target.userId}`)
      if (excludeSocketId) emitter = emitter.except(excludeSocketId)
      emitter.emit(eventName, syncPayload)
    }

    // 2. Gửi tới Context Room (Nếu có channelId hoặc conversationId)
    if (target.channelId || target.conversationId) {
      const room = target.channelId ? `channel:${target.channelId}` : `conversation:${target.conversationId}`
      
      let emitter = this.server.to(room)
      if (excludeSocketId) {
        emitter = emitter.except(excludeSocketId)
      }
      emitter.emit(eventName, syncPayload)
    }

    // 2.5. Gửi tới Thread Room (Nếu có threadId)
    if (target.threadId) {
      console.log(`[UnifiedBroadcast]  -> room: thread:${target.threadId}`)
      let emitter = this.server.to(`thread:${target.threadId}`)
      if (excludeSocketId) emitter = emitter.except(excludeSocketId)
      emitter.emit(eventName, syncPayload)
    }

    // 3. Gửi tới Workspace Room (Nếu có workspaceId và không có target cụ thể)
    if (target.workspaceId && !target.userId && !target.channelId && !target.conversationId && !target.threadId) {
      console.log(`[UnifiedBroadcast]  -> room: workspace:${target.workspaceId}`)
      let emitter = this.server.to(`workspace:${target.workspaceId}`)
      if (excludeSocketId) emitter = emitter.except(excludeSocketId)
      emitter.emit(eventName, syncPayload)
    }
  }

  /**
   * broadcastToUser — Gửi sự kiện cá nhân (Dùng cho Notification hoặc các update riêng tư)
   * @param excludeSocketId — bỏ qua tab/socket vừa gọi API (tránh echo)
   */
  broadcastToUser(
    userId: string,
    workspaceId: string,
    event: string,
    data: any,
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `user:${workspaceId}:${userId}`
    if (excludeSocketId) {
      this.server.to(room).except(excludeSocketId).emit(event, data)
    } else {
      this.server.to(room).emit(event, data)
    }
  }

  /**
   * broadcastToChannel — Gửi sự kiện tới cả channel (Dùng cho Tin nhắn mới, Typing...)
   */
  broadcastToChannel(channelId: string, event: string, data: any, excludeSocketId?: string) {
    if (!this.server) return
    const room = `channel:${channelId}`
    if (excludeSocketId) {
      this.server.to(room).except(excludeSocketId).emit(event, data)
    } else {
      this.server.to(room).emit(event, data)
    }
  }
}
