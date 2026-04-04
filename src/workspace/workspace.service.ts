import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { eq, and, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { workspaces, workspaceMembers, users } from '../database/schema'
import { MailService } from '../mail/mail.service'
import type { CreateWorkspaceDto } from './dto/create-workspace.dto'
import type { UpdateMemberStatusDto } from './dto/update-member-status.dto'
import { UserProfileBroadcastService } from '../user-profile/user-profile-broadcast.service'

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly mail: MailService,
    private readonly profileBroadcastService: UserProfileBroadcastService,
  ) {}

  async create(userId: string, dto: CreateWorkspaceDto) {
    // Check slug uniqueness
    const [existing] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, dto.slug))
      .limit(1)

    if (existing) {
      throw new ConflictException(
        'A workspace with this name already exists. Please choose a different name.',
      )
    }

    const [creator] = await this.db
      .select({ name: users.name, email: users.email, avatar: users.avatar })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    const [workspace] = await this.db
      .insert(workspaces)
      .values({
        name: dto.name,
        slug: dto.slug,
        inviteCode: dto.inviteCode,
        imageUrl: dto.imageUrl ?? '',
      })
      .returning()

    await this.db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: 'owner',
      name: creator?.name ?? null,
      avatar: creator?.avatar ?? null,
    })

    // Send invite emails to memberEmails (fire-and-forget, don't block response)
    if (dto.memberEmails && dto.memberEmails.length > 0) {
      this.sendInviteEmails({
        emails: dto.memberEmails,
        inviterName: creator?.name ?? creator?.email ?? 'Someone',
        workspaceName: workspace.name,
        inviteCode: workspace.inviteCode,
      }).catch((err) => this.logger.error('Error sending invite emails', err))
    }

    return workspace
  }

  private async sendInviteEmails(params: {
    emails: string[]
    inviterName: string
    workspaceName: string
    inviteCode: string
  }) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3045'
    const inviteUrl = `${frontendUrl}/join/${params.inviteCode}`

    const results = await Promise.allSettled(
      params.emails.map((email) =>
        this.mail.sendWorkspaceInvite(
          email,
          params.inviterName,
          params.workspaceName,
          inviteUrl,
        ),
      ),
    )

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Failed to send invite to ${params.emails[i]}: ${result.reason}`,
        )
      }
    })
  }

  async findAllByUser(userId: string) {
    const rows = await this.db
      .select({
        workspace: workspaces,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, userId))

    const workspaceIds = [...new Set(rows.map((r) => r.workspace.id))]

    const memberCounts = await Promise.all(
      workspaceIds.map(async (wid) => {
        const members = await this.db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, wid))
        return { workspaceId: wid, count: members.length }
      }),
    )

    const countMap = Object.fromEntries(
      memberCounts.map((m) => [m.workspaceId, m.count]),
    )

    const seen = new Set<string>()
    return rows
      .filter((r) => {
        if (seen.has(r.workspace.id)) return false
        seen.add(r.workspace.id)
        return true
      })
      .map((r) => ({
        ...r.workspace,
        role: r.role,
        memberCount: countMap[r.workspace.id] ?? 1,
      }))
  }

  async findOne(workspaceId: string, userId: string) {
    const [row] = await this.db
      .select({
        workspace: workspaces,
        role: workspaceMembers.role,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    if (!row) {
      throw new NotFoundException('Workspace not found or you are not a member')
    }

    return {
      ...row.workspace,
      role: row.role,
    }
  }

  async joinByInviteCode(userId: string, inviteCode: string) {
    const [workspace] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.inviteCode, inviteCode))
      .limit(1)

    if (!workspace) {
      throw new NotFoundException('Invalid invite code')
    }

    const [existing] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspace.id),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)

    if (existing) {
      throw new ConflictException('You are already a member of this workspace')
    }

    const [joinUser] = await this.db
      .select({ name: users.name, avatar: users.avatar })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    await this.db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: 'member',
      name: joinUser?.name ?? null,
      avatar: joinUser?.avatar ?? null,
    })

    return workspace
  }

  async getMembers(workspaceId: string, requestingUserId: string) {
    const [membership] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, requestingUserId),
        ),
      )
      .limit(1)

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }

    return this.db
      .select({
        id: users.id,
        name: sql<string | null>`COALESCE(${workspaceMembers.name}, ${users.name})`,
        displayName: sql<string | null>`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        email: users.email,
        avatar: sql<string | null>`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        statusText: workspaceMembers.statusText,
        statusEmoji: workspaceMembers.statusEmoji,
        statusExpiration: workspaceMembers.statusExpiration,
        notificationsPausedUntil: workspaceMembers.notificationsPausedUntil,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
  }

  async getMemberStatus(
    workspaceId: string,
    targetUserId: string,
    requestingUserId: string,
  ) {
    // Verify requesting user is a member of the workspace
    const [membership] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, requestingUserId),
        ),
      )
      .limit(1)

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }

    const [row] = await this.db
      .select({
        id: users.id,
        name: sql<string | null>`COALESCE(${workspaceMembers.name}, ${users.name})`,
        displayName: sql<string | null>`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        email: users.email,
        avatar: sql<string | null>`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        isAway: workspaceMembers.isAway,
        namePronunciation: workspaceMembers.namePronunciation,
        phone: workspaceMembers.phone,
        description: workspaceMembers.description,
        timeZone: workspaceMembers.timeZone,
        statusText: workspaceMembers.statusText,
        statusEmoji: workspaceMembers.statusEmoji,
        statusExpiration: workspaceMembers.statusExpiration,
        notificationsPausedUntil: workspaceMembers.notificationsPausedUntil,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1)

    if (!row) {
      throw new NotFoundException('Member not found in this workspace')
    }

    return row
  }

  async updateMemberStatus(
    userId: string,
    workspaceId: string,
    dto: UpdateMemberStatusDto,
  ) {
    const [updated] = await this.db
      .update(workspaceMembers)
      .set({
        ...(dto.statusText !== undefined && { statusText: dto.statusText }),
        ...(dto.statusEmoji !== undefined && { statusEmoji: dto.statusEmoji }),
        ...(dto.statusExpiration !== undefined && {
          statusExpiration: dto.statusExpiration
            ? new Date(dto.statusExpiration)
            : null,
        }),
        ...(dto.notificationsPausedUntil !== undefined && {
          notificationsPausedUntil: dto.notificationsPausedUntil
            ? new Date(dto.notificationsPausedUntil)
            : null,
        }),
      })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning()

    if (!updated) {
      throw new NotFoundException('Workspace member not found')
    }

    this.profileBroadcastService.broadcastUserProfileUpdated(workspaceId, {
      id: userId,
      statusText: updated.statusText,
      statusEmoji: updated.statusEmoji,
      statusExpiration: updated.statusExpiration,
      notificationsPausedUntil: updated.notificationsPausedUntil,
      workspaceId,
    })

    return updated
  }

  async clearMemberStatus(userId: string, workspaceId: string) {
    const [updated] = await this.db
      .update(workspaceMembers)
      .set({
        statusText: null,
        statusEmoji: null,
        statusExpiration: null,
        notificationsPausedUntil: null,
      })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning()

    if (!updated) {
      throw new NotFoundException('Workspace member not found')
    }

    this.profileBroadcastService.broadcastUserProfileUpdated(workspaceId, {
      id: userId,
      statusText: null,
      statusEmoji: null,
      statusExpiration: null,
      notificationsPausedUntil: null,
      workspaceId,
    })

    return updated
  }
}
