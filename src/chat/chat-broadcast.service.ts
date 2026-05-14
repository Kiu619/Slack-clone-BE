import { Injectable, Inject, forwardRef } from '@nestjs/common'
import { Server } from 'socket.io'
import { UnifiedBroadcastService, EntityDomain, EntityAction, type EntitySyncPayload } from './unified-broadcast.service'

/** Room `channel:id` / `conversation:id`, hoặc raw channel UUID (legacy). */
function parseChatRoom(room: string): { channelId?: string; conversationId?: string } {
  if (room.startsWith('channel:')) {
    return { channelId: room.slice('channel:'.length) }
  }
  if (room.startsWith('conversation:')) {
    return { conversationId: room.slice('conversation:'.length) }
  }
  return { channelId: room }
}

@Injectable()
export class ChatBroadcastService {
  private server: Server | null = null

  constructor(
    @Inject(forwardRef(() => UnifiedBroadcastService))
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
  ) {}

  setServer(server: Server) {
    this.server = server
  }

  /**
   * broadcastMessage — gửi message mới
   * Chỉ dùng Unified Sync cho toàn bộ UI
   */
  broadcastMessage(
    room: string,
    message: any,
    excludeSocketId?: string,
  ) {
    if (!this.server) return

    const recipientIds = (message as any).recipientIds as string[]
    const workspaceId = (message as any).workspaceId as string
    const channelId = message.channelId || (room.startsWith('channel:') ? room.split(':')[1] : undefined)
    const conversationId = message.conversationId || (room.startsWith('conversation:') ? room.split(':')[1] : undefined)
    const threadId = message.parentId || undefined

    // Gửi event metadata cho tin nhắn cha (nếu là reply)
    // Event này vẫn giữ lại vì nó là meta-update đặc thù cho UI
    if (threadId) {
      this.server.to(room).emit('message:metadata-updated', {
        messageId: threadId,
        replyCount: (message as any).parentReplyCount,
        replyParticipantIds: (message as any).parentReplyParticipantIds,
        lastReplyAt: message.createdAt,
      })
    }

    // NGUỒN DỮ LIỆU DUY NHẤT: Unified Sync
    if (workspaceId) {
      const createPayload = {
        domain: EntityDomain.CHAT,
        action: EntityAction.CREATE,
        payload: {
          id: message.id,
          data: message,
          workspaceId,
          channelId,
          conversationId,
        },
      }

      this.unifiedBroadcastService.syncEntity(
        { channelId, conversationId, workspaceId, threadId },
        createPayload,
        excludeSocketId,
      )

      // DM: fan-out tới user:{workspaceId}:{userId} để sidebar/list DM cập nhật
      // khi chưa join conversation:{id} (trùng với room conversation → client dedupe theo message.id).
      if (
        conversationId &&
        !channelId &&
        Array.isArray(recipientIds) &&
        recipientIds.length > 0
      ) {
        const seen = new Set<string>()
        for (const uid of recipientIds) {
          if (!uid || seen.has(uid)) continue
          seen.add(uid)
          this.unifiedBroadcastService.syncEntity(
            { userId: uid, workspaceId },
            createPayload,
            excludeSocketId,
          )
        }
      }

      // Sync cập nhật metadata của tin nhắn cha (replyCount, lastReplyAt) cho toàn bộ Channel/DM
      if (threadId) {
        this.unifiedBroadcastService.syncEntity(
          { channelId, conversationId, workspaceId },
          {
            domain: EntityDomain.CHAT,
            action: EntityAction.UPDATE,
            payload: {
              id: threadId,
              data: {
                replyCount: (message as any).parentReplyCount,
                lastReplyAt: message.createdAt,
                replyParticipantIds: (message as any).parentReplyParticipantIds,
              },
              workspaceId,
              channelId,
              conversationId,
            },
          },
          excludeSocketId,
        )
      }
    }
  }

  /**
   * broadcastReactionUpdate — gửi cập nhật reaction
   */
  broadcastReactionUpdate(
    room: string,
    data: {
      messageId: string
      action: 'add' | 'remove'
      emoji: string
      userId: string
      workspaceId: string
    },
    excludeSocketId?: string,
    parentId?: string,
    recipientIds?: string[],
  ) {
    if (!this.server) return

    const channelId = room.startsWith('channel:') ? room.split(':')[1] : undefined
    const conversationId = room.startsWith('conversation:') ? room.split(':')[1] : undefined
    const threadId = parentId || undefined

    if (data.workspaceId) {
      this.unifiedBroadcastService.syncEntity(
        { channelId, conversationId, workspaceId: data.workspaceId, threadId },
        {
          domain: EntityDomain.CHAT,
          action: EntityAction.UPDATE,
          payload: { 
            id: data.messageId, 
            data: { reactionUpdate: data }, 
            workspaceId: data.workspaceId, 
            channelId, 
            conversationId 
          }
        },
        excludeSocketId
      )

      // Sync tới người tham gia thread
      if (recipientIds && recipientIds.length > 0) {
        recipientIds.forEach((uid) => {
          this.unifiedBroadcastService.syncEntity(
            { userId: uid, workspaceId: data.workspaceId },
            {
              domain: EntityDomain.CHAT,
              action: EntityAction.UPDATE,
              payload: { id: data.messageId, workspaceId: data.workspaceId, channelId, conversationId }
            },
            excludeSocketId
          )
        })
      }
    }
  }

  /**
   * broadcastMessageUpdated — gửi thông báo sửa message
   */
  broadcastMessageUpdated(
    room: string,
    updated: any,
    excludeSocketId?: string,
    recipientIds?: string[],
    workspaceId?: string,
  ) {
    if (!this.server) return

    const channelId = room.startsWith('channel:') ? room.split(':')[1] : undefined
    const conversationId = room.startsWith('conversation:') ? room.split(':')[1] : undefined
    const threadId = updated.parentId || undefined

    if (workspaceId) {
      this.unifiedBroadcastService.syncEntity(
        { channelId, conversationId, workspaceId, threadId },
        {
          domain: EntityDomain.CHAT,
          action: EntityAction.UPDATE,
          payload: { id: updated.id, data: updated, workspaceId, channelId, conversationId }
        },
        excludeSocketId
      )

      if (recipientIds && recipientIds.length > 0) {
        recipientIds.forEach((uid) => {
          this.unifiedBroadcastService.syncEntity(
            { userId: uid, workspaceId },
            {
              domain: EntityDomain.CHAT,
              action: EntityAction.UPDATE,
              payload: { id: updated.id, data: updated, workspaceId, channelId, conversationId }
            },
            excludeSocketId
          )
        })
      }
    }
  }

  /**
   * broadcastMessageDeleted — gửi thông báo xóa message
   * @param transferredToConversationId — DM merge: tin chỉ gỡ khỏi room cũ, không soft-delete (payload cho client)
   */
  broadcastMessageDeleted(
    room: string,
    messageId: string,
    excludeSocketId?: string,
    parentId?: string,
    recipientIds?: string[],
    workspaceId?: string,
    transferredToConversationId?: string,
  ) {
    if (!this.server) return

    const channelId = room.startsWith('channel:') ? room.split(':')[1] : undefined
    const conversationId = room.startsWith('conversation:') ? room.split(':')[1] : undefined
    const threadId = parentId || undefined

    const deletePayload = {
      id: messageId,
      workspaceId,
      channelId,
      conversationId,
      ...(transferredToConversationId
        ? { transferredToConversationId }
        : {}),
    }

    if (workspaceId) {
      this.unifiedBroadcastService.syncEntity(
        { channelId, conversationId, workspaceId, threadId },
        {
          domain: EntityDomain.CHAT,
          action: EntityAction.DELETE,
          payload: deletePayload,
        },
        excludeSocketId,
      )

      if (recipientIds && recipientIds.length > 0) {
        recipientIds.forEach((uid) => {
          this.unifiedBroadcastService.syncEntity(
            { userId: uid, workspaceId },
            {
              domain: EntityDomain.CHAT,
              action: EntityAction.DELETE,
              payload: deletePayload,
            },
            excludeSocketId,
          )
        })
      }
    }
  }

  // ... các hàm Attachment, Pin khác cũng tương tự: chỉ dùng syncEntity ...
  // Để tiết kiệm thời gian, tôi sẽ giữ cấu trúc chính này.

  broadcastAttachmentAdded(
    room: string,
    data: { messageId: string; attachment?: unknown },
    excludeSocketId?: string,
    recipientIds?: string[],
    parentId?: string,
    workspaceId?: string,
  ) {
    const { channelId, conversationId } = parseChatRoom(room)
    const threadId = parentId || undefined
    const payload: EntitySyncPayload['payload'] = {
      id: data.messageId,
      workspaceId,
      channelId,
      conversationId,
      attachmentsChanged: true,
    }
    if (data.attachment !== undefined) {
      payload.data = { attachments: [data.attachment] }
    }
    const envelope = {
      domain: EntityDomain.CHAT,
      action: EntityAction.UPDATE,
      payload,
    }
    this.unifiedBroadcastService.syncEntity(
      { channelId, conversationId, workspaceId, threadId },
      envelope,
      excludeSocketId,
    )
    if (workspaceId && conversationId && !channelId && recipientIds?.length) {
      const seen = new Set<string>()
      for (const uid of recipientIds) {
        if (!uid || seen.has(uid)) continue
        seen.add(uid)
        this.unifiedBroadcastService.syncEntity(
          { userId: uid, workspaceId },
          envelope,
          excludeSocketId,
        )
      }
    }
  }

  broadcastAttachmentDeleted(
    room: string,
    data: { messageId: string; attachmentId: string },
    excludeSocketId?: string,
    recipientIds?: string[],
    parentId?: string,
    workspaceId?: string,
  ) {
    const { channelId, conversationId } = parseChatRoom(room)
    const threadId = parentId || undefined
    const envelope = {
      domain: EntityDomain.CHAT,
      action: EntityAction.UPDATE,
      payload: {
        id: data.messageId,
        workspaceId,
        channelId,
        conversationId,
        attachmentsChanged: true,
        deletedAttachmentId: data.attachmentId,
      },
    }
    this.unifiedBroadcastService.syncEntity(
      { channelId, conversationId, workspaceId, threadId },
      envelope,
      excludeSocketId,
    )
    if (workspaceId && conversationId && !channelId && recipientIds?.length) {
      const seen = new Set<string>()
      for (const uid of recipientIds) {
        if (!uid || seen.has(uid)) continue
        seen.add(uid)
        this.unifiedBroadcastService.syncEntity(
          { userId: uid, workspaceId },
          envelope,
          excludeSocketId,
        )
      }
    }
  }

  broadcastMessagePinned(
    room: string,
    data: { messageId: string; isPinned: boolean },
    excludeSocketId?: string,
    parentId?: string,
    recipientIds?: string[],
    workspaceId?: string,
  ) {
    const { channelId, conversationId } = parseChatRoom(room)
    const threadId = parentId || undefined
    const envelope = {
      domain: EntityDomain.CHAT,
      action: EntityAction.UPDATE,
      payload: {
        id: data.messageId,
        workspaceId,
        channelId,
        conversationId,
        data: { isPinned: data.isPinned },
      },
    }
    this.unifiedBroadcastService.syncEntity(
      { channelId, conversationId, workspaceId, threadId },
      envelope,
      excludeSocketId,
    )
    if (workspaceId && conversationId && !channelId && recipientIds?.length) {
      const seen = new Set<string>()
      for (const uid of recipientIds) {
        if (!uid || seen.has(uid)) continue
        seen.add(uid)
        this.unifiedBroadcastService.syncEntity(
          { userId: uid, workspaceId },
          envelope,
          excludeSocketId,
        )
      }
    }
  }

  /**
   * Tab Folders — client invalidate folderKeys trong useGlobalSync (CHANNEL SYNC).
   */
  broadcastFoldersSync(
    target: { channelId?: string; conversationId?: string },
    workspaceId: string,
    meta: { folderAction: 'created' | 'updated' | 'deleted' | 'attachments'; folderId?: string },
    excludeSocketId?: string,
  ) {
    const { channelId, conversationId } = target
    const contextId = channelId ?? conversationId
    if (!contextId) return
    const payload = {
      id: contextId,
      workspaceId,
      channelId,
      conversationId,
      data: {
        kind: 'folders' as const,
        action: meta.folderAction,
        folderId: meta.folderId,
      },
    }
    this.unifiedBroadcastService.syncEntity(
      { channelId, conversationId, workspaceId },
      {
        domain: EntityDomain.CHANNEL,
        action: EntityAction.SYNC,
        payload,
      },
      excludeSocketId,
    )
  }

  broadcastNotification(userId: string, workspaceId: string, notification: any) {
    if (!this.server) return
    this.server.to(`user:${workspaceId}:${userId}`).emit('notification:new', notification)
  }

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
}
