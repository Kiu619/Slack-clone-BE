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
import { ChannelBroadcastService } from './channel-broadcast.service'

/**
 * ChannelGateway — WebSocket cho metadata channel (danh sách / tên / topic…)
 *
 * Namespace: /channel
 * Rooms: workspace:${workspaceId} — broadcast channel:created | updated | deleted
 *
 * Auth: cookie access_token (giống /chat và /user-profile)
 */
@WebSocketGateway({
  namespace: '/channel',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class ChannelGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server

  private readonly logger = new Logger(ChannelGateway.name)

  constructor(
    private readonly broadcastService: ChannelBroadcastService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  afterInit(server: Server) {
    this.broadcastService.setServer(server)
    this.logger.log('ChannelGateway initialized')
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
      this.logger.log(
        `Socket ${client.id} connected to /channel: user ${payload.sub}`,
      )
    } catch (err) {
      this.logger.warn(`Socket ${client.id} (/channel): Auth failed`)
      client.disconnect()
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Socket ${client.id} disconnected from /channel`)
  }

  @SubscribeMessage('join-workspace')
  async handleJoinWorkspace(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { workspaceId: string },
  ) {
    const room = `workspace:${data.workspaceId}`
    await client.join(room)
    this.logger.log(`Socket ${client.id} joined channel room ${room}`)
    return { success: true }
  }

  @SubscribeMessage('leave-workspace')
  async handleLeaveWorkspace(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { workspaceId: string },
  ) {
    const room = `workspace:${data.workspaceId}`
    await client.leave(room)
    this.logger.log(`Socket ${client.id} left channel room ${room}`)
    return { success: true }
  }

  private extractTokenFromCookie(cookieHeader?: string): string | null {
    if (!cookieHeader) return null
    const match = cookieHeader.match(/(?:^|;\s*)access_token=([^;]+)/)
    return match ? decodeURIComponent(match[1]) : null
  }
}
