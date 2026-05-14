import { Injectable, Inject, forwardRef } from '@nestjs/common'
import { UnifiedBroadcastService, EntityDomain, EntityAction } from '../chat/unified-broadcast.service'

/**
 * Đồng bộ channel qua `entity:sync` (domain CHANNEL) tới room `workspace:${workspaceId}` trên Main Gateway.
 * Client join workspace trên namespace mặc định (`/`).
 */
@Injectable()
export class ChannelBroadcastService {
  constructor(
    @Inject(forwardRef(() => UnifiedBroadcastService))
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
  ) {}

  broadcastChannelCreated(
    workspaceId: string,
    channel: any,
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcastService.syncEntity(
      { workspaceId },
      {
        domain: EntityDomain.CHANNEL,
        action: EntityAction.CREATE,
        payload: { id: channel.id, data: channel, workspaceId },
      },
      excludeSocketId,
    )
  }

  broadcastChannelUpdated(
    workspaceId: string,
    channel: any,
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcastService.syncEntity(
      { workspaceId },
      {
        domain: EntityDomain.CHANNEL,
        action: EntityAction.UPDATE,
        payload: { id: channel.id, data: channel, workspaceId },
      },
      excludeSocketId,
    )
  }

  broadcastChannelDeleted(
    workspaceId: string,
    channelId: string,
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcastService.syncEntity(
      { workspaceId },
      {
        domain: EntityDomain.CHANNEL,
        action: EntityAction.DELETE,
        payload: { id: channelId, workspaceId },
      },
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
    this.unifiedBroadcastService.syncEntity(
      { workspaceId },
      {
        domain: EntityDomain.CHANNEL,
        action: EntityAction.SYNC,
        payload: {
          id: payload.channelId,
          workspaceId,
          channelId: payload.channelId,
          data: {
            kind: 'membership' as const,
            affectedUserId: payload.affectedUserId,
            action: payload.action,
          },
        },
      },
      excludeSocketId,
    )
  }
}
