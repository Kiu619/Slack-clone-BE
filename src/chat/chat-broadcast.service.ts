import { Injectable } from '@nestjs/common'
import { Server } from 'socket.io'

@Injectable()
export class ChatBroadcastService {
  private server: Server | null = null

  setServer(server: Server) {
    this.server = server
  }

  /**
   * broadcastMessage — gửi message mới tới channel room
   *
   * @param excludeSocketId - socket.id của người gửi (lấy từ header X-Socket-Id).
   *   Nếu có: dùng server.to(room).except(socketId) → sender không nhận lại WS event.
   *   Sender đã có message trong cache qua optimistic update → không cần WS event.
   *   Nếu không có (gửi từ ChatGateway WS event): broadcast tất cả kể cả sender.
   */
  broadcastMessage(
    channelId: string,
    message: unknown,
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `channel:${channelId}`

    if (excludeSocketId) {
      // Broadcast tới tất cả trong room TRỪ người gửi
      this.server.to(room).except(excludeSocketId).emit('message', message)
    } else {
      // Gửi từ WebSocket event (ChatGateway) → broadcast tất cả
      this.server.to(room).emit('message', message)
    }
  }

  broadcastReactionUpdate(
    channelId: string,
    data: { messageId: string; action: string; emoji: string; userId: string },
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `channel:${channelId}`
    if (excludeSocketId) {
      this.server.to(room).except(excludeSocketId).emit('reaction:update', data)
    } else {
      this.server.to(room).emit('reaction:update', data)
    }
  }

  broadcastMessageUpdated(
    channelId: string,
    data: unknown,
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `channel:${channelId}`
    if (excludeSocketId) {
      this.server.to(room).except(excludeSocketId).emit('message:updated', data)
    } else {
      this.server.to(room).emit('message:updated', data)
    }
  }

  broadcastMessageDeleted(
    channelId: string,
    messageId: string,
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `channel:${channelId}`
    if (excludeSocketId) {
      this.server
        .to(room)
        .except(excludeSocketId)
        .emit('message:deleted', { messageId })
    } else {
      this.server.to(room).emit('message:deleted', { messageId })
    }
  }

  /**
   * broadcastAttachmentAdded — broadcast khi attachment được thêm vào message
   * Emit event 'attachment:added' với messageId + attachment data
   * Frontend sẽ refetch message hoặc update local cache
   */
  broadcastAttachmentAdded(
    channelId: string,
    data: { messageId: string; attachment: unknown },
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `channel:${channelId}`
    if (excludeSocketId) {
      this.server
        .to(room)
        .except(excludeSocketId)
        .emit('attachment:added', data)
    } else {
      this.server.to(room).emit('attachment:added', data)
    }
  }

  broadcastAttachmentDeleted(
    channelId: string,
    data: { messageId: string; attachmentId: string },
    excludeSocketId?: string,
  ) {
    if (!this.server) return
    const room = `channel:${channelId}`
    if (excludeSocketId) {
      this.server
        .to(room)
        .except(excludeSocketId)
        .emit('attachment:deleted', data)
    } else {
      this.server.to(room).emit('attachment:deleted', data)
    }
  }
}
