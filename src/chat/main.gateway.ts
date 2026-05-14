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
import { UnifiedBroadcastService } from './unified-broadcast.service'
import { UserProfileBroadcastService } from '../user-profile/user-profile-broadcast.service'

interface JwtPayload {
  sub: string
  email: string
  name?: string
  avatar?: string
}

interface SocketData {
  userId: string
  userName: string | null
  userAvatar: string | null
}

@WebSocketGateway({
  // Không có namespace để biến nó thành Main Gateway
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3045',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class MainGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server

  private readonly logger = new Logger(MainGateway.name)

  /** Map socketId → userId để lookup khi disconnect */
  private socketUserMap = new Map<
    string,
    { userId: string; name: string | null }
  >()

  constructor(
    private readonly messageService: MessageService,
    private readonly chatBroadcastService: ChatBroadcastService,
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
    private readonly userProfileBroadcastService: UserProfileBroadcastService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  afterInit(server: Server) {
    const nsName = (server as any).name
    console.log(`[MainGateway] afterInit - server.name: '${nsName}'`)
    
    // UnifiedBroadcastService và ChatBroadcastService sẽ dùng chung server này (namespace /)
    this.unifiedBroadcastService.setServer(server)
    this.chatBroadcastService.setServer(server)
    // `user_profile_updated` → room `workspace:*` (client chỉ cần socket `/` + join-workspace)
    this.userProfileBroadcastService.setServer(server)

    this.logger.log('MainGateway initialized - Broadcast services connected to namespace /')
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ||
        this.extractTokenFromCookie(client.handshake.headers.cookie)

      if (!token) {
        this.logger.warn(`Socket ${client.id}: No token, disconnecting`)
        client.disconnect()
        return
      }

      const secret = this.configService.get<string>('JWT_ACCESS_SECRET')
      const payload = this.jwtService.verify<JwtPayload>(token, { secret })

      if (!payload.sub) {
        client.disconnect()
        return
      }

      const socketData = client.data as SocketData
      socketData.userId = payload.sub
      socketData.userName = payload.name ?? null
      socketData.userAvatar = payload.avatar ?? null
      
      this.socketUserMap.set(client.id, {
        userId: payload.sub,
        name: payload.name ?? null,
      })

      // 1. Join Personal Room (Toàn cục)
      await client.join(`user:${payload.sub}`)

      this.logger.log(`Socket ${client.id} connected to MainGateway: user ${payload.sub}`)
    } catch (err) {
      this.logger.warn(`Socket ${client.id}: Auth failed - ${err}`)
      client.disconnect()
    }
  }

  handleDisconnect(client: Socket) {
    const userInfo = this.socketUserMap.get(client.id)
    if (userInfo) {
      this.socketUserMap.delete(client.id)
      this.logger.log(
        `Socket ${client.id} disconnected from MainGateway: user ${userInfo.userId}`,
      )
    }
  }

  // --- Room Management ---

  @SubscribeMessage('join-workspace')
  async handleJoinWorkspace(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { workspaceId: string },
  ) {
    const userId = client.data.userId
    if (!userId) throw new WsException('Unauthorized')

    // 2. Join Personal Room (Theo Workspace) - Cần thiết cho đồng bộ thực thể trong WS
    const personalWsRoom = `user:${data.workspaceId}:${userId}`
    const workspaceRoom = `workspace:${data.workspaceId}`
    
    await client.join(personalWsRoom)
    await client.join(workspaceRoom)
    
    this.logger.log(`Socket ${client.id} joined personal ws room ${personalWsRoom} and ws room ${workspaceRoom}`)
    return { success: true }
  }

  @SubscribeMessage('leave-workspace')
  async handleLeaveWorkspace(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { workspaceId: string },
  ) {
    const userId = client.data.userId
    if (!userId) throw new WsException('Unauthorized')

    const personalWsRoom = `user:${data.workspaceId}:${userId}`
    const workspaceRoom = `workspace:${data.workspaceId}`

    await client.leave(personalWsRoom)
    await client.leave(workspaceRoom)

    this.logger.log(
      `Socket ${client.id} left ${personalWsRoom} and ${workspaceRoom}`,
    )
    return { success: true }
  }

  @SubscribeMessage('join-channel')
  async handleJoinChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const room = `channel:${data.channelId}`
    await client.join(room)
    console.log(`[MainGateway] Socket ${client.id} joined room '${room}'. Current rooms:`, Array.from(client.rooms))
    return { success: true }
  }

  @SubscribeMessage('leave-channel')
  async handleLeaveChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { channelId: string },
  ) {
    const room = `channel:${data.channelId}`
    await client.leave(room)
    console.log(`[MainGateway] Socket ${client.id} left room '${room}'. Remaining rooms:`, Array.from(client.rooms))
    return { success: true }
  }

  @SubscribeMessage('join-conversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const room = `conversation:${data.conversationId}`
    await client.join(room)
    console.log(`[MainGateway] Socket ${client.id} joined conversation room '${room}'.`)
    return { success: true }
  }

  @SubscribeMessage('leave-conversation')
  async handleLeaveConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const room = `conversation:${data.conversationId}`
    await client.leave(room)
    return { success: true }
  }

  @SubscribeMessage('join-thread')
  async handleJoinThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    const room = `thread:${data.threadId}`
    await client.join(room)
    console.log(`[MainGateway] Socket ${client.id} joined thread room '${room}'.`)
    return { success: true }
  }

  @SubscribeMessage('leave-thread')
  async handleLeaveThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ) {
    const room = `thread:${data.threadId}`
    await client.leave(room)
    return { success: true }
  }

  // --- Message Handling (Tương thích ChatGateway cũ) ---

  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      channelId?: string
      conversationId?: string
      content: string
      parentId?: string
    },
  ) {
    const userId = client.data.userId
    if (!userId) throw new WsException('Unauthorized')

    const message = await this.messageService.createMessage(
      { channelId: data.channelId, conversationId: data.conversationId },
      userId,
      { content: data.content, parentId: data.parentId },
    )

    const room = data.channelId
      ? `channel:${data.channelId}`
      : `conversation:${data.conversationId}`

    // Phát tín hiệu thông qua ChatBroadcastService (đã tích hợp Unified Sync)
    this.chatBroadcastService.broadcastMessage(room, message, client.id)

    return { success: true, messageId: message.id }
  }

  /** reaction:toggle — thêm/bỏ reaction, broadcast kết quả */
  @SubscribeMessage('reaction:toggle')
  async handleReaction(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      messageId: string
      emoji: string
      channelId?: string
      conversationId?: string
    },
  ) {
    const userId = client.data.userId
    if (!userId) throw new WsException('Unauthorized')

    const result = await this.messageService.toggleReaction(
      data.messageId,
      userId,
      { emoji: data.emoji },
    )

    const room = data.channelId
      ? `channel:${data.channelId}`
      : `conversation:${data.conversationId}`

    const { recipientIds, workspaceId } = await this.messageService.getRecipientIds(data.messageId, (result as any).parentId)

    this.chatBroadcastService.broadcastReactionUpdate(
      room,
      {
        messageId: data.messageId,
        action: result.action as 'add' | 'remove',
        emoji: result.emoji,
        userId,
        workspaceId,
      },
      client.id, // Đừng quên loại trừ người gửi ở đây để tránh lặp (infinite loop)
      (result as any).parentId ?? undefined,
      recipientIds,
    )

    return result
  }

  @SubscribeMessage('message:edit')
  async handleEditMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      messageId: string
      content: string
      channelId?: string
      conversationId?: string
    },
  ) {
    const userId = client.data.userId
    if (!userId) throw new WsException('Unauthorized')

    const updated = await this.messageService.updateMessage(
      data.messageId,
      userId,
      { content: data.content },
    )

    const room = data.channelId
      ? `channel:${data.channelId}`
      : `conversation:${data.conversationId}`

    const { recipientIds, workspaceId } = await this.messageService.getRecipientIds(data.messageId, updated.parentId)

    this.chatBroadcastService.broadcastMessageUpdated(room, updated, client.id, recipientIds, workspaceId)
    return { success: true }
  }

  @SubscribeMessage('message:delete')
  async handleDeleteMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { messageId: string; channelId?: string; conversationId?: string },
  ) {
    const userId = client.data.userId
    if (!userId) throw new WsException('Unauthorized')

    const result = await this.messageService.deleteMessage(
      data.messageId,
      userId,
    )

    const room = data.channelId
      ? `channel:${data.channelId}`
      : `conversation:${data.conversationId}`

    const { recipientIds, workspaceId } = await this.messageService.getRecipientIds(data.messageId, (result as any).parentId)

    this.chatBroadcastService.broadcastMessageDeleted(
      room,
      data.messageId,
      client.id,
      (result as any).parentId ?? undefined,
      recipientIds,
      workspaceId,
    )

    return result
  }

  @SubscribeMessage('message:pin')
  async handlePinMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { messageId: string; channelId?: string; conversationId?: string },
  ) {
    const userId = client.data.userId
    if (!userId) throw new WsException('Unauthorized')

    const result = await this.messageService.togglePin(data.messageId, userId)

    const room = data.channelId
      ? `channel:${data.channelId}`
      : `conversation:${data.conversationId}`

    const { recipientIds, workspaceId } = await this.messageService.getRecipientIds(data.messageId, (result as any).parentId)

    this.chatBroadcastService.broadcastMessagePinned(
      room,
      { messageId: data.messageId, isPinned: result.isPinned },
      client.id,
      (result as any).parentId ?? undefined,
      recipientIds,
      workspaceId,
    )

    return result
  }

  private extractTokenFromCookie(cookieHeader?: string): string | null {
    if (!cookieHeader) return null
    const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/)
    return match ? decodeURIComponent(match[1]) : null
  }
}
