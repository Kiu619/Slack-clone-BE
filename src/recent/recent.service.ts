import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { randomUUID } from 'crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  channelMembers,
  channels,
  conversationMembers,
  directMessageConversations,
  workspaceMembers,
  workspaceSidebarRecents,
} from '../database/schema'
import { UnifiedBroadcastService } from '../chat/unified-broadcast.service'
import type { RecentVisitDto } from './dto/recent-visit.dto'

export type RecentItemPayload = {
  kind: 'channel' | 'dm'
  id: string
  visitedAt: string
}

@Injectable()
export class RecentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
  ) {}

  private async assertWorkspaceMember(workspaceId: string, userId: string) {
    const [member] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)

    if (!member) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
  }

  private async assertChannelAccessible(
    workspaceId: string,
    userId: string,
    channelId: string,
  ) {
    const [row] = await this.db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.userId, userId),
          eq(channels.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    if (!row) {
      throw new ForbiddenException(
        'You must be a member of this channel to record a visit',
      )
    }
  }

  private async assertDmAccessible(
    workspaceId: string,
    userId: string,
    conversationId: string,
  ) {
    const [row] = await this.db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .innerJoin(
        directMessageConversations,
        eq(directMessageConversations.id, conversationMembers.conversationId),
      )
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
          eq(directMessageConversations.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    if (!row) {
      throw new ForbiddenException(
        'You must be a member of this conversation to record a visit',
      )
    }
  }

  private async loadRawRecents(workspaceId: string, userId: string) {
    return this.db
      .select({
        kind: workspaceSidebarRecents.kind,
        targetId: workspaceSidebarRecents.targetId,
        visitedAt: workspaceSidebarRecents.visitedAt,
      })
      .from(workspaceSidebarRecents)
      .where(
        and(
          eq(workspaceSidebarRecents.userId, userId),
          eq(workspaceSidebarRecents.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(workspaceSidebarRecents.visitedAt))
      .limit(40)
  }

  private async filterToValidItems(
    workspaceId: string,
    userId: string,
    raw: { kind: 'channel' | 'dm'; targetId: string; visitedAt: Date }[],
  ): Promise<RecentItemPayload[]> {
    const channelTargets = raw
      .filter((r) => r.kind === 'channel')
      .map((r) => r.targetId)
    const dmTargets = raw.filter((r) => r.kind === 'dm').map((r) => r.targetId)

    const validChannelIds = new Set<string>()
    if (channelTargets.length > 0) {
      const rows = await this.db
        .select({ id: channelMembers.channelId })
        .from(channelMembers)
        .innerJoin(channels, eq(channels.id, channelMembers.channelId))
        .where(
          and(
            eq(channelMembers.userId, userId),
            eq(channels.workspaceId, workspaceId),
            inArray(channelMembers.channelId, channelTargets),
          ),
        )
      for (const r of rows) validChannelIds.add(r.id)
    }

    const validDmIds = new Set<string>()
    if (dmTargets.length > 0) {
      const rows = await this.db
        .select({ id: conversationMembers.conversationId })
        .from(conversationMembers)
        .innerJoin(
          directMessageConversations,
          eq(
            directMessageConversations.id,
            conversationMembers.conversationId,
          ),
        )
        .where(
          and(
            eq(conversationMembers.userId, userId),
            eq(directMessageConversations.workspaceId, workspaceId),
            inArray(conversationMembers.conversationId, dmTargets),
          ),
        )
      for (const r of rows) validDmIds.add(r.id)
    }

    const out: RecentItemPayload[] = []
    for (const r of raw) {
      if (r.kind === 'channel' && !validChannelIds.has(r.targetId)) continue
      if (r.kind === 'dm' && !validDmIds.has(r.targetId)) continue
      out.push({
        kind: r.kind,
        id: r.targetId,
        visitedAt:
          r.visitedAt instanceof Date
            ? r.visitedAt.toISOString()
            : String(r.visitedAt),
      })
      if (out.length >= 10) break
    }
    return out
  }

  async listRecents(workspaceId: string, userId: string) {
    await this.assertWorkspaceMember(workspaceId, userId)
    const raw = await this.loadRawRecents(workspaceId, userId)
    const items = await this.filterToValidItems(workspaceId, userId, raw)
    return { items }
  }

  private async trimToMaxTen(workspaceId: string, userId: string) {
    const rows = await this.db
      .select({ id: workspaceSidebarRecents.id })
      .from(workspaceSidebarRecents)
      .where(
        and(
          eq(workspaceSidebarRecents.userId, userId),
          eq(workspaceSidebarRecents.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(workspaceSidebarRecents.visitedAt))

    const stale = rows.slice(10)
    if (stale.length === 0) return
    await this.db.delete(workspaceSidebarRecents).where(
      inArray(
        workspaceSidebarRecents.id,
        stale.map((r) => r.id),
      ),
    )
  }

  private broadcastRecents(
    userId: string,
    workspaceId: string,
    items: RecentItemPayload[],
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcastService.broadcastToUser(
      userId,
      workspaceId,
      'sidebar:recent',
      { workspaceId, items },
      excludeSocketId,
    )
  }

  async recordVisit(
    workspaceId: string,
    userId: string,
    dto: RecentVisitDto,
    excludeSocketId?: string,
  ) {
    await this.assertWorkspaceMember(workspaceId, userId)

    if (dto.kind === 'channel') {
      const [ch] = await this.db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(eq(channels.id, dto.id), eq(channels.workspaceId, workspaceId)),
        )
        .limit(1)
      if (!ch) {
        throw new NotFoundException('Channel not found')
      }
      await this.assertChannelAccessible(workspaceId, userId, dto.id)
    } else {
      const [conv] = await this.db
        .select({ id: directMessageConversations.id })
        .from(directMessageConversations)
        .where(
          and(
            eq(directMessageConversations.id, dto.id),
            eq(directMessageConversations.workspaceId, workspaceId),
          ),
        )
        .limit(1)
      if (!conv) {
        throw new NotFoundException('Conversation not found')
      }
      await this.assertDmAccessible(workspaceId, userId, dto.id)
    }

    const now = new Date()
    await this.db
      .insert(workspaceSidebarRecents)
      .values({
        id: randomUUID(),
        userId,
        workspaceId,
        kind: dto.kind,
        targetId: dto.id,
        visitedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceSidebarRecents.userId,
          workspaceSidebarRecents.workspaceId,
          workspaceSidebarRecents.kind,
          workspaceSidebarRecents.targetId,
        ],
        set: { visitedAt: now },
      })

    await this.trimToMaxTen(workspaceId, userId)

    const raw = await this.loadRawRecents(workspaceId, userId)
    const items = await this.filterToValidItems(workspaceId, userId, raw)
    this.broadcastRecents(userId, workspaceId, items, excludeSocketId)
    return { items }
  }
}
