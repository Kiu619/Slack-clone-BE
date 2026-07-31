import { Injectable } from '@nestjs/common'
import { Server } from 'socket.io'
import {
  type HuddleSessionSnapshot,
  type HuddleStateSnapshot,
  type HuddleTarget,
} from './huddle.types'

export interface HuddleBroadcastPayload {
  reason:
    | 'start'
    | 'join'
    | 'leave'
    | 'webhook'
    | 'state'
    | 'history'
    | 'topic_update'
  target: HuddleTarget
  state: HuddleStateSnapshot
  session: HuddleSessionSnapshot | null
}

@Injectable()
export class HuddleBroadcastService {
  private server: Server | null = null

  setServer(server: Server) {
    this.server = server
  }

  broadcastState(
    target: HuddleTarget,
    payload: HuddleBroadcastPayload,
    excludeSocketId?: string,
  ) {
    if (!this.server) return

    const room =
      target.entityType === 'channel'
        ? `channel:${target.entityId}`
        : `conversation:${target.entityId}`

    const emitTo = (roomName: string) => {
      let emitter = this.server!.to(roomName)
      if (excludeSocketId) {
        emitter = emitter.except(excludeSocketId)
      }
      emitter.emit('huddle:state', payload)
    }

    emitTo(room)
    emitTo(`workspace:${target.workspaceId}`)
  }
}
