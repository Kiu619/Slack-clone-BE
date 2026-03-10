import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  channels,
  channelMembers,
  workspaceMembers,
  users,
} from '../database/schema'
import type { CreateChannelDto } from './dto/create-channel.dto'

@Injectable()
export class ChannelService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_]/g, '')
  }

  private async assertMembership(workspaceId: string, userId: string) {
    const [member] = await this.db
      .select({ id: workspaceMembers.id, role: workspaceMembers.role })
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
    return member
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateChannelDto,
  ) {
    await this.assertMembership(workspaceId, userId)

    const slug = this.slugify(dto.name)

    const [existing] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(eq(channels.workspaceId, workspaceId), eq(channels.slug, slug)),
      )
      .limit(1)

    if (existing) {
      throw new ConflictException(
        'A channel with this name already exists in this workspace.',
      )
    }

    const [channel] = await this.db
      .insert(channels)
      .values({
        id: randomUUID(),
        workspaceId,
        name: dto.name,
        slug,
        type: dto.type ?? 'text',
        isPrivate: dto.isPrivate ?? false,
        description: dto.description ?? null,
        createdById: userId,
      })
      .returning()

    // For private channels, immediately add the creator as a member
    if (channel.isPrivate) {
      await this.db.insert(channelMembers).values({
        id: randomUUID(),
        channelId: channel.id,
        userId,
      })
    }

    return channel
  }

  async findAllByWorkspace(workspaceId: string, userId: string) {
    await this.assertMembership(workspaceId, userId)

    // Return public channels + private channels where user is a member
    const publicChannels = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.isPrivate, false),
        ),
      )

    const privateChannels = await this.db
      .select({ channel: channels })
      .from(channelMembers)
      .innerJoin(channels, eq(channelMembers.channelId, channels.id))
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.isPrivate, true),
          eq(channelMembers.userId, userId),
        ),
      )

    return [
      ...publicChannels,
      ...privateChannels.map((r) => r.channel),
    ].sort((a, b) => a.name.localeCompare(b.name))
  }

  async findOne(channelId: string, workspaceId: string, userId: string) {
    await this.assertMembership(workspaceId, userId)

    const [channel] = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    if (!channel) {
      throw new NotFoundException('Channel not found')
    }

    if (channel.isPrivate) {
      const [membership] = await this.db
        .select({ id: channelMembers.id })
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.channelId, channelId),
            eq(channelMembers.userId, userId),
          ),
        )
        .limit(1)

      if (!membership) {
        throw new ForbiddenException('You do not have access to this channel')
      }
    }

    return channel
  }

  async delete(channelId: string, workspaceId: string, userId: string) {
    const member = await this.assertMembership(workspaceId, userId)

    if (member.role === 'member') {
      throw new ForbiddenException('Only admins and owners can delete channels')
    }

    const [channel] = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    if (!channel) {
      throw new NotFoundException('Channel not found')
    }

    await this.db.delete(channels).where(eq(channels.id, channelId))

    return { message: 'Channel deleted successfully' }
  }

  async getMembers(channelId: string, workspaceId: string, userId: string) {
    await this.assertMembership(workspaceId, userId)

    const [channel] = await this.db
      .select({ isPrivate: channels.isPrivate })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, workspaceId),
        ),
      )
      .limit(1)

    if (!channel) throw new NotFoundException('Channel not found')

    return this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatar: users.avatar,
        joinedAt: channelMembers.joinedAt,
      })
      .from(channelMembers)
      .innerJoin(users, eq(channelMembers.userId, users.id))
      .where(eq(channelMembers.channelId, channelId))
  }
}
