import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { MessageService } from '../message/message.service'
import { ChatBroadcastService } from './chat-broadcast.service'

/**
 * ChatGateway — WebSocket gateway cho real-time chat
 *
 * Namespace: /chat (để tách biệt với các WebSocket khác nếu có)
 * Rooms: mỗi channel là một room `channel:${channelId}`
 *        mỗi user cũng join room `user:${userId}` để nhận DM sau này
 *
 * Auth flow:
 *   Client → handshake với cookie access_token
 *   Gateway → verify JWT → lấy userId
 *   Nếu invalid → disconnect ngay
 *
 * Events client → server:
 *   join-channel    { channelId }
 *   leave-channel   { channelId }
 *   message         { channelId, content, parentId? }
 *   reaction:toggle { messageId, emoji }
 *   message:edit    { messageId, content }
 *   message:delete  { messageId }
 *
 * Events server → client:
 *   message         Message object (broadcast to channel room)
 *   typing          { channelId, user, isTyping }
 *   message:updated { messageId, content, editedAt }
 *   message:deleted { messageId }
 *   reaction:update { messageId, reactions[] }
 */
@WebSocketGateway({
  namespace: '/chat',
  cors: {
    // Cho phép từ frontend URL — sẽ config qua env sau
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  // Cookie-based auth: đọc access_token từ cookie
  transports: ['websocket', 'polling'],
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server

  private readonly logger = new Logger(ChatGateway.name)

  /** Map socketId → userId để lookup khi disconnect */
  private socketUserMap = new Map<
    string,
    { userId: string; name: string | null }
  >()

  constructor(
    private readonly messageService: MessageService,
    private readonly broadcastService: ChatBroadcastService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * afterInit — chạy sau khi WebSocket server khởi tạo xong
   * Set server instance vào ChatBroadcastService để REST controller dùng
   */
  afterInit(server: Server) {
    this.broadcastService.setServer(server)
    this.logger.log('ChatGateway initialized, broadcast service ready')
  }

  /**
   * handleConnection — chạy khi client kết nối WebSocket
   *
   * userId + **default** name/avatar từ JWT (bảng users, không phải profile workspace).
   * Tên theo workspace lấy từ payload message / API channels.
   */
  handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        this.extractTokenFromCookie(client.handshake.headers.cookie)

      if (!token) {
        this.logger.warn(`Socket ${client.id}: No token, disconnecting`)
        client.disconnect()
        return
      }

      const secret = this.configService.get<string>('JWT_ACCESS_SECRET')
      const payload = this.jwtService.verify(token, { secret })

      if (!payload.sub) {
        client.disconnect()
        return
      }

      // Đọc trực tiếp từ JWT — không cần DB query
      client.data.userId = payload.sub
      client.data.userName = payload.name ?? null
      client.data.userAvatar = payload.avatar ?? null
      this.socketUserMap.set(client.id, {
        userId: payload.sub,
        name: payload.name ?? null,
      })

      void client.join(`user:${payload.sub}`)

      this.logger.log(`Socket ${client.id} connected: user ${payload.sub}`)
    } catch (err) {
      this.logger.warn(`Socket ${client.id}: Auth failed - ${err}`)
      client.disconnect()
    }
  }

  /** handleDisconnect — cleanup khi client ngắt kết nối */
  handleDisconnect(client: Socket) {
    const userInfo = this.socketUserMap.get(client.id)
    if (userInfo) {
      this.socketUserMap.delete(client.id)
      this.logger.log(
        `Socket ${client.id} disconnected: user ${userInfo.userId}`,
      )
    }
  }

  /**
   * join-channel — client join vào room của channel
   * Gọi khi user navigate vào một channel
   */
  @SubscribeMessage('join-channel')
  async handleJoinChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const room = `channel:${data.channelId}`
    await client.join(room)
    this.logger.log(`Socket ${client.id} joined room ${room}`)
    return { success: true }
  }

  /** leave-channel — client rời khỏi room */
  @SubscribeMessage('leave-channel')
  async handleLeaveChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const room = `channel:${data.channelId}`
    await client.leave(room)
    return { success: true }
  }

  /**
   * join-thread — client join vào room của thread
   * Gọi khi user mở Side Panel của một thread
   */
  @SubscribeMessage('join-thread')
  async handleJoinThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    const room = `thread:${data.threadId}`
    await client.join(room)
    this.logger.log(`Socket ${client.id} joined thread room ${room}`)
    return { success: true }
  }

  /** leave-thread — client rời khỏi room thread */
  @SubscribeMessage('leave-thread')
  async handleLeaveThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    const room = `thread:${data.threadId}`
    await client.leave(room)
    return { success: true }
  }

  /**
   * message — nhận message mới từ client qua WebSocket
   *
   * MessageService.createMessage luôn lấy user info từ DB
   * → avatar/name real-time (Slack behavior).
   */
  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { channelId: string; content: string; parentId?: string },
  ) {
    const userId = client.data.userId as string
    if (!userId) throw new WsException('Unauthorized')

    const message = await this.messageService.createMessage(
      data.channelId,
      userId,
      { content: data.content, parentId: data.parentId },
    )

    // Broadcast tới tất cả clients trong channel room (kể cả người gửi)
    this.server.to(`channel:${data.channelId}`).emit('message', message)

    return { success: true, messageId: message.id }
  }

  /** reaction:toggle — thêm/bỏ reaction, broadcast kết quả */
  @SubscribeMessage('reaction:toggle')
  async handleReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { messageId: string; emoji: string; channelId: string },
  ) {
    const userId = client.data.userId as string
    if (!userId) throw new WsException('Unauthorized')

    const result = await this.messageService.toggleReaction(
      data.messageId,
      userId,
      { emoji: data.emoji },
    )

    // Broadcast reaction update tới channel room
    this.server.to(`channel:${data.channelId}`).emit('reaction:update', {
      messageId: data.messageId,
      action: result.action,
      emoji: result.emoji,
      userId,
    })

    return result
  }

  /** message:edit — chỉnh sửa message */
  @SubscribeMessage('message:edit')
  async handleEditMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { messageId: string; content: string; channelId: string },
  ) {
    const userId = client.data.userId as string
    if (!userId) throw new WsException('Unauthorized')

    const updated = await this.messageService.updateMessage(
      data.messageId,
      userId,
      { content: data.content },
    )

    this.server.to(`channel:${data.channelId}`).emit('message:updated', updated)
    return { success: true }
  }

  /** message:delete — xóa message */
  @SubscribeMessage('message:delete')
  async handleDeleteMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: string; channelId: string },
  ) {
    const userId = client.data.userId as string
    if (!userId) throw new WsException('Unauthorized')

    const result = await this.messageService.deleteMessage(
      data.messageId,
      userId,
    )

    this.server.to(`channel:${data.channelId}`).emit('message:deleted', {
      messageId: data.messageId,
    })

    return result
  }

  // ─── Helper ────────────────────────────────────────────────────────────────

  /** Đọc access_token từ Cookie header string */
  private extractTokenFromCookie(cookieHeader?: string): string | null {
    if (!cookieHeader) return null
    const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/)
    return match ? decodeURIComponent(match[1]) : null
  }
}
