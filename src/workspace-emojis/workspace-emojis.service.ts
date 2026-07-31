import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'

import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  workspaceCustomEmojis,
  workspaceEmojiSettings,
  workspaceMembers,
  users,
} from '../database/schema'
import {
  UnifiedBroadcastService,
  EntityAction,
  EntityDomain,
} from '../chat/unified-broadcast.service'
import { WorkspacePermissionsService } from '../workspace/workspace-permissions.service'
import type {
  CreateWorkspaceCustomEmojiAliasDto,
  CreateWorkspaceCustomEmojiDto,
  UpdateWorkspaceEmojiOneClickDto,
  WorkspaceCustomEmojisQueryDto,
} from './dto/workspace-emojis.dto'

const CUSTOM_EMOJI_NAME_REGEX = /^[a-z0-9_]+$/
const CUSTOM_SHORTCODE_REGEX = /^:([a-z0-9_]+):$/

function normalizeEmojiName(value: string) {
  return value
    .trim()
    .replace(/^:+|:+$/g, '')
    .toLowerCase()
}

function formatShortcode(name: string) {
  return `:${normalizeEmojiName(name)}:`
}

function normalizeOneClickSlot(value: string | null) {
  if (value === null) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const customMatch = trimmed.toLowerCase().match(CUSTOM_SHORTCODE_REGEX)
  if (customMatch) {
    return formatShortcode(customMatch[1])
  }

  if (trimmed.startsWith(':') || trimmed.endsWith(':')) {
    throw new BadRequestException(
      'Custom emoji shortcodes must use the format :name:',
    )
  }

  return trimmed
}

function extractCustomEmojiName(value: string | null) {
  if (!value) return null
  const customMatch = value.trim().toLowerCase().match(CUSTOM_SHORTCODE_REGEX)
  return customMatch?.[1] ?? null
}

function buildTwemojiUrl(emoji: string) {
  const codepoints = Array.from(emoji)
    .map((char) => char.codePointAt(0)?.toString(16))
    .filter((value): value is string => Boolean(value))
    .join('-')

  return `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${codepoints}.png`
}

@Injectable()
export class WorkspaceEmojisService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissionsService: WorkspacePermissionsService,
    private readonly unifiedBroadcastService: UnifiedBroadcastService,
  ) {}

  private async assertActiveWorkspaceMember(
    workspaceId: string,
    userId: string,
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
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)

    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace')
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenException('Your workspace membership is deactivated')
    }
  }

  private validateEmojiName(name: string) {
    const normalized = normalizeEmojiName(name)
    if (!normalized) {
      throw new BadRequestException('Emoji name is required')
    }
    if (!CUSTOM_EMOJI_NAME_REGEX.test(normalized)) {
      throw new BadRequestException(
        'Emoji name can only contain lowercase letters, numbers, and underscores',
      )
    }
    return normalized
  }

  private async ensureEmojiSettingsRow(workspaceId: string) {
    const [existing] = await this.db
      .select({ id: workspaceEmojiSettings.id })
      .from(workspaceEmojiSettings)
      .where(eq(workspaceEmojiSettings.workspaceId, workspaceId))
      .limit(1)

    if (existing) return existing.id

    const [created] = await this.db
      .insert(workspaceEmojiSettings)
      .values({ workspaceId })
      .returning({ id: workspaceEmojiSettings.id })

    return created?.id ?? null
  }

  private async getEmojiSettingsRow(workspaceId: string) {
    await this.ensureEmojiSettingsRow(workspaceId)
    const [row] = await this.db
      .select()
      .from(workspaceEmojiSettings)
      .where(eq(workspaceEmojiSettings.workspaceId, workspaceId))
      .limit(1)
    return row ?? null
  }

  private async getEmojiById(workspaceId: string, emojiId: string) {
    const [row] = await this.db
      .select()
      .from(workspaceCustomEmojis)
      .where(
        and(
          eq(workspaceCustomEmojis.workspaceId, workspaceId),
          eq(workspaceCustomEmojis.id, emojiId),
        ),
      )
      .limit(1)

    return row ?? null
  }

  private broadcastEmojiSync(
    workspaceId: string,
    emojiId: string,
    action: EntityAction,
    data?: Record<string, unknown>,
    excludeSocketId?: string,
  ) {
    this.unifiedBroadcastService.syncEntity(
      { workspaceId },
      {
        domain: EntityDomain.EMOJI,
        action,
        payload: {
          id: emojiId,
          workspaceId,
          data,
        },
      },
      excludeSocketId,
    )
  }

  async getWorkspaceEmojiBundle(workspaceId: string, userId: string) {
    await this.assertActiveWorkspaceMember(workspaceId, userId)
    await this.ensureEmojiSettingsRow(workspaceId)

    const [settings, emojis] = await Promise.all([
      this.getEmojiSettingsRow(workspaceId),
      this.db
        .select({
          id: workspaceCustomEmojis.id,
          workspaceId: workspaceCustomEmojis.workspaceId,
          name: workspaceCustomEmojis.name,
          imageUrl: workspaceCustomEmojis.imageUrl,
          aliasOfId: workspaceCustomEmojis.aliasOfId,
          sourceDefaultEmoji: workspaceCustomEmojis.sourceDefaultEmoji,
          createdById: workspaceCustomEmojis.createdById,
          createdAt: workspaceCustomEmojis.createdAt,
          updatedAt: workspaceCustomEmojis.updatedAt,
          createdByIdUserId: users.id,
          createdByName: users.name,
          createdByDisplayName: workspaceMembers.displayName,
          createdByAvatar: users.avatar,
        })
        .from(workspaceCustomEmojis)
        .leftJoin(users, eq(workspaceCustomEmojis.createdById, users.id))
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, users.id),
          ),
        )
        .where(eq(workspaceCustomEmojis.workspaceId, workspaceId))
        .orderBy(workspaceCustomEmojis.createdAt, workspaceCustomEmojis.name),
    ])

    return {
      customEmojis: emojis.map((emoji) => ({
        id: emoji.id,
        workspaceId: emoji.workspaceId,
        name: emoji.name,
        imageUrl: emoji.imageUrl,
        aliasOfId: emoji.aliasOfId,
        sourceDefaultEmoji: emoji.sourceDefaultEmoji,
        createdById: emoji.createdById,
        createdBy: emoji.createdByIdUserId
          ? {
              id: emoji.createdByIdUserId,
              name: emoji.createdByName ?? null,
              displayName:
                emoji.createdByDisplayName ?? emoji.createdByName ?? null,
              avatar: emoji.createdByAvatar ?? null,
            }
          : null,
        createdAt: emoji.createdAt,
        updatedAt: emoji.updatedAt,
      })),
      emojiOneClickSlots: [
        settings?.slot1Emoji ?? null,
        settings?.slot2Emoji ?? null,
        settings?.slot3Emoji ?? null,
      ] as [string | null, string | null, string | null],
    }
  }

  async getCustomEmojisPage(
    workspaceId: string,
    userId: string,
    query: WorkspaceCustomEmojisQueryDto,
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, userId)

    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 25
    const sortBy = query.sortBy ?? 'name'
    const sortDirection = query.sortDirection ?? 'asc'
    const q = query.q?.trim() ?? ''

    const createdByExpr = sql<string>`COALESCE(${workspaceMembers.displayName}, ${workspaceMembers.name}, ${users.name})`
    const whereCond = q
      ? and(
          eq(workspaceCustomEmojis.workspaceId, workspaceId),
          or(
            ilike(workspaceCustomEmojis.name, `%${q}%`),
            ilike(createdByExpr, `%${q}%`),
          ),
        )
      : eq(workspaceCustomEmojis.workspaceId, workspaceId)

    const sortColumn =
      sortBy === 'createdAt'
        ? workspaceCustomEmojis.createdAt
        : sortBy === 'createdBy'
          ? createdByExpr
          : workspaceCustomEmojis.name
    const sortOrder = sortDirection === 'desc' ? desc : asc

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceCustomEmojis)
      .leftJoin(users, eq(workspaceCustomEmojis.createdById, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, users.id),
        ),
      )
      .where(whereCond)

    const total = count ?? 0
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(Math.max(page, 1), totalPages)
    const offset = (safePage - 1) * pageSize

    const items = await this.db
      .select({
        id: workspaceCustomEmojis.id,
        workspaceId: workspaceCustomEmojis.workspaceId,
        name: workspaceCustomEmojis.name,
        imageUrl: workspaceCustomEmojis.imageUrl,
        aliasOfId: workspaceCustomEmojis.aliasOfId,
        sourceDefaultEmoji: workspaceCustomEmojis.sourceDefaultEmoji,
        createdById: workspaceCustomEmojis.createdById,
        createdAt: workspaceCustomEmojis.createdAt,
        updatedAt: workspaceCustomEmojis.updatedAt,
        createdByIdUserId: users.id,
        createdByName: users.name,
        createdByDisplayName: workspaceMembers.displayName,
        createdByAvatar: users.avatar,
      })
      .from(workspaceCustomEmojis)
      .leftJoin(users, eq(workspaceCustomEmojis.createdById, users.id))
      .leftJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, users.id),
        ),
      )
      .where(whereCond)
      .orderBy(sortOrder(sortColumn), asc(workspaceCustomEmojis.id))
      .limit(pageSize)
      .offset(offset)

    return {
      items: items.map((emoji) => ({
        id: emoji.id,
        workspaceId: emoji.workspaceId,
        name: emoji.name,
        imageUrl: emoji.imageUrl,
        aliasOfId: emoji.aliasOfId,
        sourceDefaultEmoji: emoji.sourceDefaultEmoji,
        createdById: emoji.createdById,
        createdBy: emoji.createdByIdUserId
          ? {
              id: emoji.createdByIdUserId,
              name: emoji.createdByName ?? null,
              displayName:
                emoji.createdByDisplayName ?? emoji.createdByName ?? null,
              avatar: emoji.createdByAvatar ?? null,
            }
          : null,
        createdAt: emoji.createdAt,
        updatedAt: emoji.updatedAt,
      })),
      total,
      page: safePage,
      pageSize,
      totalPages,
    }
  }

  async createCustomEmoji(
    workspaceId: string,
    userId: string,
    dto: CreateWorkspaceCustomEmojiDto,
    excludeSocketId?: string,
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, userId)
    await this.permissionsService.requireUserPermission(
      workspaceId,
      userId,
      'add_and_edit_custom_emoji',
    )

    const name = this.validateEmojiName(dto.name)
    const [duplicate] = await this.db
      .select({ id: workspaceCustomEmojis.id })
      .from(workspaceCustomEmojis)
      .where(
        and(
          eq(workspaceCustomEmojis.workspaceId, workspaceId),
          eq(workspaceCustomEmojis.name, name),
        ),
      )
      .limit(1)

    if (duplicate) {
      throw new ConflictException(
        'This emoji name already exists in the workspace',
      )
    }

    const [created] = await this.db
      .insert(workspaceCustomEmojis)
      .values({
        workspaceId,
        name,
        imageUrl: dto.imageUrl.trim(),
        createdById: userId,
      })
      .returning()

    if (!created) {
      throw new BadRequestException('Could not create custom emoji')
    }

    this.broadcastEmojiSync(workspaceId, created.id, EntityAction.CREATE, {
      ...created,
    }, excludeSocketId)

    return created
  }

  async createCustomEmojiAlias(
    workspaceId: string,
    userId: string,
    dto: CreateWorkspaceCustomEmojiAliasDto,
    excludeSocketId?: string,
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, userId)
    await this.permissionsService.requireUserPermission(
      workspaceId,
      userId,
      'add_and_edit_custom_emoji',
    )

    const aliasName = this.validateEmojiName(dto.alias)
    const [duplicate] = await this.db
      .select({ id: workspaceCustomEmojis.id })
      .from(workspaceCustomEmojis)
      .where(
        and(
          eq(workspaceCustomEmojis.workspaceId, workspaceId),
          eq(workspaceCustomEmojis.name, aliasName),
        ),
      )
      .limit(1)

    if (duplicate) {
      throw new ConflictException(
        'This emoji name already exists in the workspace',
      )
    }

    const sourceEmojiId = dto.sourceEmojiId?.trim() ?? null
    const sourceDefaultEmoji = dto.sourceDefaultEmoji?.trim() ?? null
    const sourceEmoji = sourceEmojiId
      ? await this.getEmojiById(workspaceId, sourceEmojiId)
      : null

    if (sourceEmojiId && !sourceEmoji) {
      throw new NotFoundException('Source emoji not found')
    }

    if (!sourceEmojiId && !sourceDefaultEmoji) {
      throw new BadRequestException('Source emoji is required')
    }

    const [aliasCreated] = await this.db
      .insert(workspaceCustomEmojis)
      .values({
        workspaceId,
        name: aliasName,
        imageUrl: sourceEmoji
          ? sourceEmoji.imageUrl
          : buildTwemojiUrl(sourceDefaultEmoji!),
        aliasOfId: sourceEmoji
          ? (sourceEmoji.aliasOfId ?? sourceEmoji.id)
          : null,
        sourceDefaultEmoji,
        createdById: userId,
      })
      .returning()

    if (!aliasCreated) {
      throw new BadRequestException('Could not create custom emoji alias')
    }

    this.broadcastEmojiSync(workspaceId, aliasCreated.id, EntityAction.CREATE, {
      ...aliasCreated,
    }, excludeSocketId)

    return aliasCreated
  }

  async updateOneClickReactions(
    workspaceId: string,
    userId: string,
    dto: UpdateWorkspaceEmojiOneClickDto,
    excludeSocketId?: string,
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, userId)
    await this.permissionsService.requireUserPermission(
      workspaceId,
      userId,
      'add_and_edit_custom_emoji',
    )

    await this.ensureEmojiSettingsRow(workspaceId)

    const normalizedSlots = dto.slots.map((slot) =>
      normalizeOneClickSlot(slot),
    ) as [string | null, string | null, string | null]

    const customEmojiNames = Array.from(
      new Set(
        normalizedSlots
          .map((slot) => extractCustomEmojiName(slot))
          .filter((name): name is string => Boolean(name)),
      ),
    )

    if (customEmojiNames.length > 0) {
      const existing = await this.db
        .select({ name: workspaceCustomEmojis.name })
        .from(workspaceCustomEmojis)
        .where(
          and(
            eq(workspaceCustomEmojis.workspaceId, workspaceId),
            inArray(workspaceCustomEmojis.name, customEmojiNames),
          ),
        )

      const existingNames = new Set(existing.map((row) => row.name))
      const missing = customEmojiNames.filter(
        (name) => !existingNames.has(name),
      )

      if (missing.length > 0) {
        throw new NotFoundException(
          `Emoji not found: ${missing.map((name) => formatShortcode(name)).join(', ')}`,
        )
      }
    }

    const [updated] = await this.db
      .update(workspaceEmojiSettings)
      .set({
        slot1Emoji: normalizedSlots[0],
        slot2Emoji: normalizedSlots[1],
        slot3Emoji: normalizedSlots[2],
      })
      .where(eq(workspaceEmojiSettings.workspaceId, workspaceId))
      .returning()

    if (!updated) {
      throw new BadRequestException('Could not update one-click reactions')
    }

    this.broadcastEmojiSync(
      workspaceId,
      `settings:${workspaceId}`,
      EntityAction.UPDATE,
      {
        slot1Emoji: updated.slot1Emoji,
        slot2Emoji: updated.slot2Emoji,
        slot3Emoji: updated.slot3Emoji,
      },
      excludeSocketId,
    )

    return updated
  }

  async deleteCustomEmoji(
    workspaceId: string,
    userId: string,
    emojiId: string,
    excludeSocketId?: string,
  ) {
    await this.assertActiveWorkspaceMember(workspaceId, userId)
    await this.permissionsService.requireUserPermission(
      workspaceId,
      userId,
      'delete_custom_emoji',
    )

    const target = await this.getEmojiById(workspaceId, emojiId)
    if (!target) {
      throw new NotFoundException('Emoji not found')
    }

    const rowsToDelete = await this.db
      .select({
        id: workspaceCustomEmojis.id,
        name: workspaceCustomEmojis.name,
      })
      .from(workspaceCustomEmojis)
      .where(
        and(
          eq(workspaceCustomEmojis.workspaceId, workspaceId),
          or(
            eq(workspaceCustomEmojis.id, emojiId),
            eq(workspaceCustomEmojis.aliasOfId, emojiId),
          ),
        ),
      )

    const shortcodeSet = new Set(
      rowsToDelete.map((row) => formatShortcode(row.name)),
    )
    const settings = await this.getEmojiSettingsRow(workspaceId)

    const nextSlots = settings
      ? [
          shortcodeSet.has(settings.slot1Emoji ?? '')
            ? null
            : settings.slot1Emoji,
          shortcodeSet.has(settings.slot2Emoji ?? '')
            ? null
            : settings.slot2Emoji,
          shortcodeSet.has(settings.slot3Emoji ?? '')
            ? null
            : settings.slot3Emoji,
        ]
      : [null, null, null]

    await this.db.transaction(async (tx) => {
      await tx
        .delete(workspaceCustomEmojis)
        .where(
          and(
            eq(workspaceCustomEmojis.workspaceId, workspaceId),
            inArray(
              workspaceCustomEmojis.id,
              rowsToDelete.map((row) => row.id),
            ),
          ),
        )

      await tx
        .update(workspaceEmojiSettings)
        .set({
          slot1Emoji: nextSlots[0],
          slot2Emoji: nextSlots[1],
          slot3Emoji: nextSlots[2],
        })
        .where(eq(workspaceEmojiSettings.workspaceId, workspaceId))
    })

    this.broadcastEmojiSync(workspaceId, emojiId, EntityAction.DELETE, {
      deletedEmojiId: emojiId,
      aliasOfId: target.aliasOfId,
      sourceDefaultEmoji: target.sourceDefaultEmoji,
    }, excludeSocketId)

    return { ok: true }
  }
}
