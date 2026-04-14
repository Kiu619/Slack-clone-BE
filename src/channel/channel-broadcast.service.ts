import { Injectable } from '@nestjs/common'
import { Server } from 'socket.io'

/**
 * Broadcast channel CRUD tới room `workspace:${workspaceId}` trên namespace `/channel`.
 * Client join qua ChannelGateway `join-workspace`.
 */
@Injectable()
export class ChannelBroadcastService {
  private server: Server | null = null

  setServer(server: Server) {
    this.server = server
  }

  private emitToWorkspace(
    workspaceId: string,
    event: string,
    payload: unknown,
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `workspace:${workspaceId}`
    if (excludeSocketId) {
      this.server.to(room).except(excludeSocketId).emit(event, payload)
    } else {
      this.server.to(room).emit(event, payload)
    }
  }

  broadcastChannelCreated(
    workspaceId: string,
    channel: unknown,
    excludeSocketId?: string,
  ) {
    this.emitToWorkspace(
      workspaceId,
      'channel:created',
      { workspaceId, channel },
      excludeSocketId,
    )
  }

  broadcastChannelUpdated(
    workspaceId: string,
    channel: unknown,
    excludeSocketId?: string,
  ) {
    this.emitToWorkspace(
      workspaceId,
      'channel:updated',
      { workspaceId, channel },
      excludeSocketId,
    )
  }

  broadcastChannelDeleted(
    workspaceId: string,
    channelId: string,
    excludeSocketId?: string,
  ) {
    this.emitToWorkspace(
      workspaceId,
      'channel:deleted',
      { workspaceId, channelId },
      excludeSocketId,
    )
  }

  /**
   * Thêm / gỡ thành viên channel — client cập nhật sidebar (người bị ảnh hưởng) + Members tab (mọi người trong workspace).
   */
  broadcastChannelMembershipChanged(
    workspaceId: string,
    payload: {
      channelId: string
      affectedUserId: string
      action: 'member_added' | 'member_removed'
    },
    excludeSocketId?: string,
  ) {
    this.emitToWorkspace(
      workspaceId,
      'channel:membership:changed',
      { workspaceId, ...payload },
      excludeSocketId,
    )
  }
}
