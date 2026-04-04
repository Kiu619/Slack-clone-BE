import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtService } from '@nestjs/jwt'
import { UserProfileBroadcastService } from './user-profile-broadcast.service'

/**
 * UserProfileGateway — WebSocket gateway cho real-time profile & status
 * 
 * Namespace: /user-profile
 * Rooms: mỗi workspace là một room `workspace:${workspaceId}`
 */
@WebSocketGateway({
  namespace: '/user-profile',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class UserProfileGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server

  private readonly logger = new Logger(UserProfileGateway.name)

  constructor(
    private readonly broadcastService: UserProfileBroadcastService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  afterInit(server: Server) {
    this.broadcastService.setServer(server)
    this.logger.log('UserProfileGateway initialized')
  }

  handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        this.extractTokenFromCookie(client.handshake.headers.cookie)

      if (!token) {
        client.disconnect()
        return
      }

      const secret = this.configService.get<string>('JWT_ACCESS_SECRET')
      const payload = this.jwtService.verify(token, { secret })

      if (!payload.sub) {
        client.disconnect()
        return
      }

      client.data.userId = payload.sub
      this.logger.log(`Socket ${client.id} connected to /user-profile: user ${payload.sub}`)
    } catch (err) {
      this.logger.warn(`Socket ${client.id} (/user-profile): Auth failed`)
      client.disconnect()
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Socket ${client.id} disconnected from /user-profile`)
  }

  @SubscribeMessage('join-workspace')
  async handleJoinWorkspace(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { workspaceId: string },
  ) {
    const room = `workspace:${data.workspaceId}`
    await client.join(room)
    this.logger.log(`Socket ${client.id} joined workspace room ${room}`)
    return { success: true }
  }

  @SubscribeMessage('leave-workspace')
  async handleLeaveWorkspace(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { workspaceId: string },
  ) {
    const room = `workspace:${data.workspaceId}`
    await client.leave(room)
    this.logger.log(`Socket ${client.id} left workspace room ${room}`)
    return { success: true }
  }

  private extractTokenFromCookie(cookieHeader?: string): string | null {
    if (!cookieHeader) return null
    const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/)
    return match ? decodeURIComponent(match[1]) : null
  }
}
