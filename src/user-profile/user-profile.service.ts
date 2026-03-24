import {
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'
import { eq, and } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { users, workspaceMembers } from '../database/schema'
import type { UpdateProfileDto } from './dto/update-profile.dto'
import type { UpdateContactDto } from './dto/update-contact.dto'
import type { UpdateAboutMeDto } from './dto/update-about-me.dto'
import { RedisService } from '../redis/redis.service'

@Injectable()
export class UserProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly redis: RedisService,
  ) {}

  private async assertWorkspaceMember(workspaceId: string, userId: string) {
    const [m] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)
    if (!m) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
  }

  private profileCacheKeys(workspaceId: string, userId: string) {
    return {
      member: `ws:${workspaceId}:user:${userId}:profile`,
      legacy: `user:${userId}:profile`,
    }
  }

  async invalidateProfileCache(workspaceId: string, userId: string) {
    const k = this.profileCacheKeys(workspaceId, userId)
    await this.redis.del(k.member)
    await this.redis.del(k.legacy)
  }

  async getProfile(userId: string, workspaceId: string) {
    await this.assertWorkspaceMember(workspaceId, userId)

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        accountName: users.name,
        accountAvatar: users.avatar,
        wmName: workspaceMembers.name,
        wmAvatar: workspaceMembers.avatar,
        displayName: workspaceMembers.displayName,
        isAway: workspaceMembers.isAway,
        status: workspaceMembers.status,
        namePronunciation: workspaceMembers.namePronunciation,
        phone: workspaceMembers.phone,
        description: workspaceMembers.description,
        timeZone: workspaceMembers.timeZone,
      })
      .from(users)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .where(eq(users.id, userId))
      .limit(1)

    if (!row) throw new NotFoundException('User not found')

    return { ...this.toPublicProfile(row), workspaceId }
  }

  async updateProfile(
    userId: string,
    workspaceId: string,
    dto: UpdateProfileDto,
  ) {
    await this.assertWorkspaceMember(workspaceId, userId)

    const [updated] = await this.db
      .update(workspaceMembers)
      .set({
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
        ...(dto.namePronunciation !== undefined && {
          namePronunciation: dto.namePronunciation,
        }),
        ...(dto.timeZone !== undefined && { timeZone: dto.timeZone }),
        ...(dto.avatar !== undefined && { avatar: dto.avatar }),
        ...(dto.isAway !== undefined && { isAway: dto.isAway }),
        ...(dto.status !== undefined && { status: dto.status }),
      })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning()

    if (!updated) throw new NotFoundException('Workspace member not found')

    await this.invalidateProfileCache(workspaceId, userId)

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        accountName: users.name,
        accountAvatar: users.avatar,
        wmName: workspaceMembers.name,
        wmAvatar: workspaceMembers.avatar,
        displayName: workspaceMembers.displayName,
        isAway: workspaceMembers.isAway,
        status: workspaceMembers.status,
        namePronunciation: workspaceMembers.namePronunciation,
        phone: workspaceMembers.phone,
        description: workspaceMembers.description,
        timeZone: workspaceMembers.timeZone,
      })
      .from(users)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .where(eq(users.id, userId))
      .limit(1)

    if (!row) throw new NotFoundException('User not found')
    return { ...this.toPublicProfile(row), workspaceId }
  }

  async updateContact(
    userId: string,
    workspaceId: string,
    dto: UpdateContactDto,
  ) {
    await this.assertWorkspaceMember(workspaceId, userId)

    const [updated] = await this.db
      .update(workspaceMembers)
      .set({
        ...(dto.phone !== undefined && { phone: dto.phone }),
      })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning()

    if (!updated) throw new NotFoundException('Workspace member not found')

    await this.invalidateProfileCache(workspaceId, userId)

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        accountName: users.name,
        accountAvatar: users.avatar,
        wmName: workspaceMembers.name,
        wmAvatar: workspaceMembers.avatar,
        displayName: workspaceMembers.displayName,
        isAway: workspaceMembers.isAway,
        status: workspaceMembers.status,
        namePronunciation: workspaceMembers.namePronunciation,
        phone: workspaceMembers.phone,
        description: workspaceMembers.description,
        timeZone: workspaceMembers.timeZone,
      })
      .from(users)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .where(eq(users.id, userId))
      .limit(1)

    if (!row) throw new NotFoundException('User not found')
    return { ...this.toPublicProfile(row), workspaceId }
  }

  async updateAboutMe(
    userId: string,
    workspaceId: string,
    dto: UpdateAboutMeDto,
  ) {
    await this.assertWorkspaceMember(workspaceId, userId)

    const [updated] = await this.db
      .update(workspaceMembers)
      .set({
        ...(dto.description !== undefined && { description: dto.description }),
      })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .returning()

    if (!updated) throw new NotFoundException('Workspace member not found')

    await this.invalidateProfileCache(workspaceId, userId)

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        accountName: users.name,
        accountAvatar: users.avatar,
        wmName: workspaceMembers.name,
        wmAvatar: workspaceMembers.avatar,
        displayName: workspaceMembers.displayName,
        isAway: workspaceMembers.isAway,
        status: workspaceMembers.status,
        namePronunciation: workspaceMembers.namePronunciation,
        phone: workspaceMembers.phone,
        description: workspaceMembers.description,
        timeZone: workspaceMembers.timeZone,
      })
      .from(users)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .where(eq(users.id, userId))
      .limit(1)

    if (!row) throw new NotFoundException('User not found')
    return { ...this.toPublicProfile(row), workspaceId }
  }

  private toPublicProfile(row: {
    id: string
    email: string
    accountName: string | null
    accountAvatar: string | null
    wmName: string | null
    wmAvatar: string | null
    displayName: string | null
    isAway: boolean
    status: string | null
    namePronunciation: string | null
    phone: string | null
    description: string | null
    timeZone: string | null
  }) {
    const name = row.wmName ?? row.accountName ?? null
    const avatar = row.wmAvatar ?? row.accountAvatar ?? null
    return {
      id: row.id,
      email: row.email,
      name,
      displayName: row.displayName ?? name,
      avatar,
      isAway: row.isAway,
      status: row.status,
      namePronunciation: row.namePronunciation,
      phone: row.phone,
      description: row.description,
      timeZone: row.timeZone,
    }
  }
}
