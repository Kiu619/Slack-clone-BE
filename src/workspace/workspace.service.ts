import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { eq, and, sql, asc, desc, ilike, or, inArray } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  channelMembers,
  channels,
  conversationMembers,
  directMessageConversations,
  workspaces,
  workspaceMembers,
  users,
} from '../database/schema'
import { MailService } from '../mail/mail.service'
import { WorkspacePermissionsService } from './workspace-permissions.service'
import type { WorkspacePermissionKey } from './workspace-permissions.constants'
import type { CreateWorkspaceDto } from './dto/create-workspace.dto'
import type { UpdateMemberStatusDto } from './dto/update-member-status.dto'
import type { UpdateMemberRoleDto } from './dto/update-member-role.dto'
import type { UpdateWorkspacePermissionDto } from './dto/update-workspace-permission.dto'
import { UserProfileBroadcastService } from '../user-profile/user-profile-broadcast.service'
import { ChannelService } from '../channel/channel.service'
import { WorkspaceEmojisService } from '../workspace-emojis/workspace-emojis.service'
import {
  UnifiedBroadcastService,
  EntityAction,
  EntityDomain,
} from '../chat/unified-broadcast.service'

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly mail: MailService,
    private readonly profileBroadcastService: UserProfileBroadcastService,
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
    private readonly channelService: ChannelService,
    private readonly permissionsService: WorkspacePermissionsService,
    private readonly workspaceEmojisService: WorkspaceEmojisService,
  ) {}

  private async getWorkspaceMembership(workspaceId: string, userId: string) {
    const [membership] = await this.db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        membershipStatus: workspaceMembers.membershipStatus,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)
    return membership ?? null
  }

  private async assertActiveWorkspaceMember(
    workspaceId: string,
    userId: string,
  ) {
    const membership = await this.getWorkspaceMembership(workspaceId, userId)
    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }
    return membership
  }

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
      role: 'primary_owner',
      name: creator?.name ?? null,
      avatar: creator?.avatar ?? null,
      theme: null,
    })

    await this.permissionsService.seedWorkspacePermissions(workspace.id)

    const defaultChannelName = this.channelService.channelNameFromWorkspaceSlug(
      dto.slug,
    )
    await this.channelService.create(workspace.id, userId, {
      name: defaultChannelName,
      type: 'text',
      isPrivate: false,
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

  /**
   * Gửi email mời tham gia workspace (link /join/:inviteCode) — Resend.
   * Bỏ qua email đã là member workspace.
   */
  async sendWorkspaceInvitesByEmail(
    workspaceId: string,
    requesterId: string,
    emails: string[],
    channelId?: string,
  ) {
    const [membership] = await this.db
      .select({
        id: workspaceMembers.id,
        membershipStatus: workspaceMembers.membershipStatus,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, requesterId),
        ),
      )
      .limit(1)

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }
    await this.permissionsService.requireUserPermission(
      workspaceId,
      requesterId,
      'manage_user_permissions',
    )

    const [workspace] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    if (!workspace) {
      throw new NotFoundException('Workspace not found')
    }

    const [inviter] = await this.db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, requesterId))
      .limit(1)

    const inviterName = inviter?.name ?? inviter?.email ?? 'Someone'

    let inviteChannelName: string | undefined
    if (channelId) {
      const ch = await this.channelService.findOne(
        channelId,
        workspaceId,
        requesterId,
      )
      inviteChannelName = ch.name
    }

    const membersWithEmail = await this.db
      .select({ email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))

    const memberEmailSet = new Set(
      membersWithEmail.map((m) => m.email.toLowerCase()),
    )

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3045'
    const inviteUrl = `${frontendUrl}/join/${workspace.inviteCode}`

    const seen = new Set<string>()
    let sent = 0
    let skipped = 0
    const failed: { email: string; message: string }[] = []

    for (const raw of emails) {
      const trimmed = raw.trim()
      const lower = trimmed.toLowerCase()
      if (!lower || seen.has(lower)) continue
      seen.add(lower)

      if (memberEmailSet.has(lower)) {
        skipped++
        continue
      }

      try {
        await this.mail.sendWorkspaceInvite(
          trimmed,
          inviterName,
          workspace.name,
          inviteUrl,
          inviteChannelName,
        )
        sent++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.warn(`Invite email failed for ${trimmed}: ${msg}`)
        failed.push({ email: trimmed, message: msg })
      }
    }

    return { sent, skipped, failed }
  }

  async findAllByUser(userId: string) {
    const rows = await this.db
      .select({
        workspace: workspaces,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.membershipStatus, 'active'),
        ),
      )

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
          eq(workspaceMembers.membershipStatus, 'active'),
        ),
      )
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    if (!row) {
      throw new NotFoundException('Workspace not found or you are not a member')
    }

    const permissions =
      await this.permissionsService.getWorkspacePermissions(workspaceId)
    const emojiBundle =
      await this.workspaceEmojisService.getWorkspaceEmojiBundle(
        workspaceId,
        userId,
      )

    return {
      ...row.workspace,
      role: row.role,
      permissions,
      ...emojiBundle,
    }
  }

  async getPermissions(workspaceId: string, requestingUserId: string) {
    await this.assertActiveWorkspaceMember(workspaceId, requestingUserId)
    return this.permissionsService.getWorkspacePermissions(workspaceId)
  }

  async updatePermission(
    workspaceId: string,
    requestingUserId: string,
    permissionKey: WorkspacePermissionKey,
    dto: UpdateWorkspacePermissionDto,
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, requestingUserId)
    await this.permissionsService.requireUserPermission(
      workspaceId,
      requestingUserId,
      'manage_user_permissions',
    )

    return this.permissionsService.updateWorkspacePermission(
      workspaceId,
      permissionKey,
      dto.roles,
    )
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
      theme: null,
    })

    await this.channelService.ensureMembershipInDefaultChannel(
      workspace.id,
      userId,
    )

    return workspace
  }

  async getMembers(workspaceId: string, requestingUserId: string) {
    await this.assertActiveWorkspaceMember(workspaceId, requestingUserId)

    return this.db
      .select({
        id: users.id,
        name: sql<
          string | null
        >`COALESCE(${workspaceMembers.name}, ${users.name})`,
        displayName: sql<
          string | null
        >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        email: users.email,
        avatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        membershipStatus: workspaceMembers.membershipStatus,
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

  async getMembersPage(
    workspaceId: string,
    requestingUserId: string,
    query: {
      page?: number
      pageSize?: number
      sortBy?:
        | 'fullName'
        | 'displayName'
        | 'email'
        | 'accountType'
        | 'joined'
        | 'status'
      sortDirection?: 'asc' | 'desc'
      q?: string
    },
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, requestingUserId)

    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 25
    const sortBy = query.sortBy ?? 'fullName'
    const sortDirection = query.sortDirection ?? 'asc'
    const q = query.q?.trim() ?? ''

    const fullNameExpr = sql<
      string | null
    >`COALESCE(${workspaceMembers.name}, ${users.name})`
    const displayNameExpr = sql<
      string | null
    >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`
    const accountTypeExpr = sql<string>`CASE ${workspaceMembers.role} WHEN 'primary_owner' THEN 'Primary Workspace Owner' WHEN 'owner' THEN 'Workspace Owner' WHEN 'admin' THEN 'Workspace Admin' ELSE 'Regular Member' END`

    const whereCond = q
      ? and(
          eq(workspaceMembers.workspaceId, workspaceId),
          or(
            ilike(users.email, `%${q}%`),
            ilike(fullNameExpr, `%${q}%`),
            ilike(displayNameExpr, `%${q}%`),
            ilike(accountTypeExpr, `%${q}%`),
          ),
        )
      : eq(workspaceMembers.workspaceId, workspaceId)

    const sortColumn =
      sortBy === 'displayName'
        ? displayNameExpr
        : sortBy === 'email'
          ? users.email
          : sortBy === 'accountType'
            ? workspaceMembers.role
            : sortBy === 'status'
              ? workspaceMembers.membershipStatus
              : sortBy === 'joined'
                ? workspaceMembers.joinedAt
                : fullNameExpr

    const sortOrder = sortDirection === 'desc' ? desc : asc

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(whereCond)

    const total = count ?? 0
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(Math.max(page, 1), totalPages)
    const offset = (safePage - 1) * pageSize

    const items = await this.db
      .select({
        id: users.id,
        name: sql<
          string | null
        >`COALESCE(${workspaceMembers.name}, ${users.name})`,
        displayName: sql<
          string | null
        >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        email: users.email,
        avatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        membershipStatus: workspaceMembers.membershipStatus,
        statusText: workspaceMembers.statusText,
        statusEmoji: workspaceMembers.statusEmoji,
        statusExpiration: workspaceMembers.statusExpiration,
        notificationsPausedUntil: workspaceMembers.notificationsPausedUntil,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(whereCond)
      .orderBy(sortOrder(sortColumn), asc(users.id))
      .limit(pageSize)
      .offset(offset)

    return {
      items,
      total,
      page: safePage,
      pageSize,
      totalPages,
    }
  }

  async getMemberStatus(
    workspaceId: string,
    targetUserId: string,
    requestingUserId: string,
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, requestingUserId)

    const [row] = await this.db
      .select({
        id: users.id,
        name: sql<
          string | null
        >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated user' ELSE COALESCE(${workspaceMembers.name}, ${users.name}) END`,
        displayName: sql<
          string | null
        >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated user' ELSE COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name}) END`,
        email: sql<string>`CASE WHEN ${workspaceMembers.id} IS NULL THEN '' ELSE ${users.email} END`,
        avatar: sql<
          string | null
        >`CASE WHEN ${workspaceMembers.id} IS NULL THEN NULL ELSE COALESCE(${workspaceMembers.avatar}, ${users.avatar}) END`,
        isAway: sql<boolean>`COALESCE(${workspaceMembers.isAway}, false)`,
        membershipStatus: sql<
          'active' | 'deactivated'
        >`CASE WHEN ${workspaceMembers.id} IS NULL THEN 'deactivated' ELSE ${workspaceMembers.membershipStatus} END`,
        namePronunciation: workspaceMembers.namePronunciation,
        phone: workspaceMembers.phone,
        description: workspaceMembers.description,
        timeZone: workspaceMembers.timeZone,
        statusText: workspaceMembers.statusText,
        statusEmoji: workspaceMembers.statusEmoji,
        statusExpiration: workspaceMembers.statusExpiration,
        notificationsPausedUntil: workspaceMembers.notificationsPausedUntil,
      })
      .from(users)
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .where(eq(users.id, targetUserId))
      .limit(1)

    if (!row) {
      throw new NotFoundException('User not found')
    }

    return row
  }

  async updateMemberStatus(
    userId: string,
    workspaceId: string,
    dto: UpdateMemberStatusDto,
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, userId)

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
    await this.assertActiveWorkspaceMember(workspaceId, userId)

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

  async updateMemberRole(
    workspaceId: string,
    requesterId: string,
    targetUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    if (requesterId === targetUserId) {
      throw new ForbiddenException('You cannot change your own role')
    }

    const [requesterMembership] = await this.db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        membershipStatus: workspaceMembers.membershipStatus,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, requesterId),
        ),
      )
      .limit(1)

    if (!requesterMembership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
    if (requesterMembership.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }

    await this.permissionsService.requireUserPermission(
      workspaceId,
      requesterId,
      'manage_user_permissions',
    )

    const [targetMembership] = await this.db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        userId: workspaceMembers.userId,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1)

    if (!targetMembership) {
      throw new NotFoundException('Workspace member not found')
    }

    if (
      targetMembership.role === 'primary_owner' &&
      dto.role !== 'primary_owner'
    ) {
      throw new ForbiddenException(
        'Primary owner can only be transferred to another member',
      )
    }

    if (dto.role === 'primary_owner') {
      if (requesterMembership.role !== 'primary_owner') {
        throw new ForbiddenException(
          'Only the primary owner can transfer primary ownership',
        )
      }

      await this.db.transaction(async (tx) => {
        await tx
          .update(workspaceMembers)
          .set({ role: 'owner' })
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, requesterId),
            ),
          )

        await tx
          .update(workspaceMembers)
          .set({ role: 'primary_owner' })
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              eq(workspaceMembers.userId, targetUserId),
            ),
          )
      })
    } else {
      await this.db
        .update(workspaceMembers)
        .set({ role: dto.role })
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        )
    }

    const [updated] = await this.db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        membershipStatus: workspaceMembers.membershipStatus,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1)

    if (!updated) {
      throw new NotFoundException('Workspace member not found')
    }

    const [row] = await this.db
      .select({
        id: users.id,
        name: sql<
          string | null
        >`COALESCE(${workspaceMembers.name}, ${users.name})`,
        displayName: sql<
          string | null
        >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        email: users.email,
        avatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        membershipStatus: workspaceMembers.membershipStatus,
        statusText: workspaceMembers.statusText,
        statusEmoji: workspaceMembers.statusEmoji,
        statusExpiration: workspaceMembers.statusExpiration,
        notificationsPausedUntil: workspaceMembers.notificationsPausedUntil,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
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
      throw new NotFoundException('Workspace member not found')
    }

    this.profileBroadcastService.broadcastUserProfileUpdated(workspaceId, {
      ...row,
      workspaceId,
    })
    this.unifiedBroadcastService.syncEntity(
      { workspaceId },
      {
        domain: EntityDomain.USER,
        action: EntityAction.UPDATE,
        payload: {
          id: targetUserId,
          data: { ...row, workspaceId },
          workspaceId,
        },
      },
    )

    if (dto.role === 'primary_owner') {
      const [requesterRow] = await this.db
        .select({
          id: users.id,
          name: sql<
            string | null
          >`COALESCE(${workspaceMembers.name}, ${users.name})`,
          displayName: sql<
            string | null
          >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
          email: users.email,
          avatar: sql<
            string | null
          >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
          membershipStatus: workspaceMembers.membershipStatus,
          statusText: workspaceMembers.statusText,
          statusEmoji: workspaceMembers.statusEmoji,
          statusExpiration: workspaceMembers.statusExpiration,
          notificationsPausedUntil: workspaceMembers.notificationsPausedUntil,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, requesterId),
          ),
        )
        .limit(1)

      if (requesterRow) {
        this.profileBroadcastService.broadcastUserProfileUpdated(workspaceId, {
          ...requesterRow,
          workspaceId,
        })
        this.unifiedBroadcastService.syncEntity(
          { workspaceId },
          {
            domain: EntityDomain.USER,
            action: EntityAction.UPDATE,
            payload: {
              id: requesterId,
              data: { ...requesterRow, workspaceId },
              workspaceId,
            },
          },
        )
      }
    }

    return row
  }

  async updateWorkspaceMemberAccessStatus(
    workspaceId: string,
    requesterId: string,
    targetUserId: string,
    status: 'active' | 'deactivated',
  ) {
    if (requesterId === targetUserId) {
      throw new ForbiddenException('You cannot change your own status')
    }

    const [requesterMembership] = await this.db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        membershipStatus: workspaceMembers.membershipStatus,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, requesterId),
        ),
      )
      .limit(1)

    if (!requesterMembership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
    if (requesterMembership.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }

    await this.permissionsService.requireUserPermission(
      workspaceId,
      requesterId,
      'manage_user_permissions',
    )

    const [updated] = await this.db
      .update(workspaceMembers)
      .set({ membershipStatus: status })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .returning()

    if (!updated) {
      throw new NotFoundException('Workspace member not found')
    }

    const [row] = await this.db
      .select({
        id: users.id,
        name: sql<
          string | null
        >`COALESCE(${workspaceMembers.name}, ${users.name})`,
        displayName: sql<
          string | null
        >`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`,
        email: users.email,
        avatar: sql<
          string | null
        >`COALESCE(${workspaceMembers.avatar}, ${users.avatar})`,
        membershipStatus: workspaceMembers.membershipStatus,
        statusText: workspaceMembers.statusText,
        statusEmoji: workspaceMembers.statusEmoji,
        statusExpiration: workspaceMembers.statusExpiration,
        notificationsPausedUntil: workspaceMembers.notificationsPausedUntil,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
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
      throw new NotFoundException('Workspace member not found')
    }

    this.profileBroadcastService.broadcastUserProfileUpdated(workspaceId, {
      ...row,
      workspaceId,
    })
    this.unifiedBroadcastService.syncEntity(
      { workspaceId },
      {
        domain: EntityDomain.USER,
        action: EntityAction.UPDATE,
        payload: {
          id: targetUserId,
          data: { ...row, workspaceId },
          workspaceId,
        },
      },
    )

    return row
  }

  async removeDeactivatedWorkspaceMember(
    workspaceId: string,
    requesterId: string,
    targetUserId: string,
  ) {
    if (requesterId === targetUserId) {
      throw new ForbiddenException('You cannot remove your own membership')
    }

    const requesterMembership = await this.getWorkspaceMembership(
      workspaceId,
      requesterId,
    )

    if (!requesterMembership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
    if (requesterMembership.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }

    await this.permissionsService.requireUserPermission(
      workspaceId,
      requesterId,
      'manage_user_permissions',
    )

    const [targetMembership] = await this.db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
        membershipStatus: workspaceMembers.membershipStatus,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, targetUserId),
        ),
      )
      .limit(1)

    if (!targetMembership) {
      throw new NotFoundException('Workspace member not found')
    }

    if (targetMembership.membershipStatus !== 'deactivated') {
      throw new ForbiddenException('Only deactivated members can be removed')
    }

    await this.db.transaction(async (tx) => {
      const channelRows = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.workspaceId, workspaceId))

      const channelIds = channelRows.map((row) => row.id)
      if (channelIds.length > 0) {
        await tx
          .delete(channelMembers)
          .where(
            and(
              eq(channelMembers.userId, targetUserId),
              inArray(channelMembers.channelId, channelIds),
            ),
          )
      }

      const conversationRows = await tx
        .select({ id: directMessageConversations.id })
        .from(directMessageConversations)
        .where(eq(directMessageConversations.workspaceId, workspaceId))

      const conversationIds = conversationRows.map((row) => row.id)
      if (conversationIds.length > 0) {
        await tx
          .delete(conversationMembers)
          .where(
            and(
              eq(conversationMembers.userId, targetUserId),
              inArray(conversationMembers.conversationId, conversationIds),
            ),
          )
      }

      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, targetUserId),
          ),
        )
    })

    const payload = {
      id: targetUserId,
      userId: targetUserId,
      workspaceId,
      membershipStatus: 'deactivated',
      removed: true,
    }

    this.profileBroadcastService.broadcastUserProfileUpdated(
      workspaceId,
      payload,
    )
    this.unifiedBroadcastService.syncEntity(
      { workspaceId },
      {
        domain: EntityDomain.USER,
        action: EntityAction.DELETE,
        payload: {
          id: targetUserId,
          workspaceId,
          data: payload,
        },
      },
    )

    return payload
  }
}
