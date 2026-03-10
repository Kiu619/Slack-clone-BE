import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { eq, and } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { workspaces, workspaceMembers, users } from '../database/schema'
import { MailService } from '../mail/mail.service'
import type { CreateWorkspaceDto } from './dto/create-workspace.dto'

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly mail: MailService,
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

    // Get creator info for invite emails
    const [creator] = await this.db
      .select({ name: users.name, email: users.email })
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

    // Add creator as owner
    await this.db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: 'owner',
    })

    // Send invite emails to memberEmails (fire-and-forget, don't block response)
    if (dto.memberEmails && dto.memberEmails.length > 0) {
      this.sendInviteEmails({
        emails: dto.memberEmails,
        inviterName: creator?.name ?? creator?.email ?? 'Someone',
        workspaceName: workspace.name,
        inviteCode: workspace.inviteCode,
      }).catch((err) =>
        this.logger.error('Error sending invite emails', err),
      )
    }

    return workspace
  }

  private async sendInviteEmails(params: {
    emails: string[]
    inviterName: string
    workspaceName: string
    inviteCode: string
  }) {
    const frontendUrl =
      process.env.FRONTEND_URL ?? 'http://localhost:3045'
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
      .select({ workspace: workspaces, role: workspaceMembers.role })
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

    return { ...row.workspace, role: row.role }
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

    await this.db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role: 'member',
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
        name: users.name,
        email: users.email,
        avatar: users.avatar,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.joinedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
  }
}
