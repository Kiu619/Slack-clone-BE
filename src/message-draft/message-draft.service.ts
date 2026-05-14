import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common'
import { and, desc, eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { messageDrafts, workspaceMembers } from '../database/schema'
import { UnifiedBroadcastService } from '../chat/unified-broadcast.service'

@Injectable()
export class MessageDraftService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly unifiedBroadcast: UnifiedBroadcastService,
  ) {}

  private assertContextKeyForWorkspace(
    workspaceId: string,
    contextKey: string,
  ) {
    const prefix = `ws:${workspaceId}:`
    if (!contextKey.startsWith(prefix)) {
      throw new BadRequestException('contextKey does not match workspace')
    }
  }

  private async assertMember(workspaceId: string, userId: string) {
    const [row] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)
    if (!row) {
      throw new ForbiddenException('Not a member of this workspace')
    }
  }

  private broadcast(
    userId: string,
    workspaceId: string,
    action: 'upsert' | 'delete',
    payload: {
      id?: string
      contextKey: string
      content?: string
      updatedAt?: string
    },
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcast.broadcastToUser(
      userId,
      workspaceId,
      'draft:sync',
      { action, workspaceId, ...payload },
      excludeSocketId,
    )
  }

  async list(workspaceId: string, userId: string) {
    await this.assertMember(workspaceId, userId)
    return this.db
      .select({
        id: messageDrafts.id,
        contextKey: messageDrafts.contextKey,
        content: messageDrafts.content,
        updatedAt: messageDrafts.updatedAt,
      })
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.workspaceId, workspaceId),
          eq(messageDrafts.userId, userId),
        ),
      )
      .orderBy(desc(messageDrafts.updatedAt))
  }

  async findByContext(
    workspaceId: string,
    userId: string,
    contextKey: string,
  ) {
    await this.assertMember(workspaceId, userId)
    this.assertContextKeyForWorkspace(workspaceId, contextKey)
    const [row] = await this.db
      .select({
        id: messageDrafts.id,
        contextKey: messageDrafts.contextKey,
        content: messageDrafts.content,
        updatedAt: messageDrafts.updatedAt,
      })
      .from(messageDrafts)
      .where(
        and(
          eq(messageDrafts.workspaceId, workspaceId),
          eq(messageDrafts.userId, userId),
          eq(messageDrafts.contextKey, contextKey),
        ),
      )
      .limit(1)
    return row ?? null
  }

  /** Plain text strip — đồng bộ logic gần FE */
  private hasMeaningfulText(html: string): boolean {
    const text = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .trim()
    return text.length > 0
  }

  async upsert(
    workspaceId: string,
    userId: string,
    contextKey: string,
    content: string,
    excludeSocketId?: string,
  ) {
    await this.assertMember(workspaceId, userId)
    this.assertContextKeyForWorkspace(workspaceId, contextKey)

    if (!this.hasMeaningfulText(content)) {
      return this.remove(workspaceId, userId, contextKey, excludeSocketId)
    }

    const id = randomUUID()
    const now = new Date()

    const [row] = await this.db
      .insert(messageDrafts)
      .values({
        id,
        userId,
        workspaceId,
        contextKey,
        content,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [messageDrafts.userId, messageDrafts.contextKey],
        set: {
          content,
          workspaceId,
          updatedAt: now,
        },
      })
      .returning({
        id: messageDrafts.id,
        contextKey: messageDrafts.contextKey,
        content: messageDrafts.content,
        updatedAt: messageDrafts.updatedAt,
      })

    const saved = row!
    this.broadcast(
      userId,
      workspaceId,
      'upsert',
      {
        id: saved.id,
        contextKey: saved.contextKey,
        content: saved.content,
        updatedAt:
          saved.updatedAt instanceof Date
            ? saved.updatedAt.toISOString()
            : String(saved.updatedAt),
      },
      excludeSocketId,
    )
    return saved
  }

  async remove(
    workspaceId: string,
    userId: string,
    contextKey: string,
    excludeSocketId?: string,
  ) {
    await this.assertMember(workspaceId, userId)
    this.assertContextKeyForWorkspace(workspaceId, contextKey)

    const deleted = await this.db
      .delete(messageDrafts)
      .where(
        and(
          eq(messageDrafts.workspaceId, workspaceId),
          eq(messageDrafts.userId, userId),
          eq(messageDrafts.contextKey, contextKey),
        ),
      )
      .returning({ id: messageDrafts.id })

    if (deleted.length > 0) {
      this.broadcast(
        userId,
        workspaceId,
        'delete',
        { contextKey },
        excludeSocketId,
      )
    }
    return { ok: true as const, deleted: deleted.length > 0 }
  }
}
