import { Injectable } from '@nestjs/common'
import { Server } from 'socket.io'

@Injectable()
export class UserProfileBroadcastService {
  private server: Server | null = null

  setServer(server: Server) {
    this.server = server
  }

  /**
   * broadcastUserProfileUpdated — gửi thông báo cập nhật profile tới toàn bộ workspace room
   * 
   * @param workspaceId - ID của workspace
   * @param data - Dữ liệu update (userId, statusEmoji, statusText, isAway, etc.)
   * @param excludeSocketId - (Tùy chọn) Socket ID để loại trừ khỏi việc broadcast (thường là người gửi)
   */
  broadcastUserProfileUpdated(
    workspaceId: string,
    data: any,
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `workspace:${workspaceId}`

    if (excludeSocketId) {
      this.server
        .to(room)
        .except(excludeSocketId)
        .emit('user_profile_updated', data)
    } else {
      this.server.to(room).emit('user_profile_updated', data)
    }
  }
}
