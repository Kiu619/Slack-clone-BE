import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq, inArray } from 'drizzle-orm'
import * as schema from '../database/schema'

type SeedOptions = {
  workspaceId: string
  channelId: string
  totalUsers?: number
  adminCount?: number
}

const DEFAULT_WORKSPACE_ID = '56c4cb3e-80d6-4668-927d-5f86f0079918'
const DEFAULT_CHANNEL_ID = 'd951ef13-d9d6-4841-bb94-e99453ab405b'
const DEFAULT_TOTAL_USERS = 1000
const DEFAULT_ADMIN_COUNT = 15

function slugPart(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.+/g, '.')
}

function pad(n: number) {
  return String(n).padStart(4, '0')
}

function pickRole(index: number, adminCount: number) {
  return index < adminCount ? 'admin' : 'member'
}

function randomAvatar(seed: string) {
  return `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(seed)}`
}

function randomJoinedAt(index: number) {
  const daysBack = 365 - (index % 365)
  const date = new Date()
  date.setDate(date.getDate() - daysBack)
  date.setHours(9 + (index % 8), index % 60, index % 60, 0)
  return date
}

function randomWorkspaceName(index: number) {
  const firstNames = [
    'Minh',
    'An',
    'Linh',
    'Tuan',
    'Huy',
    'Hoa',
    'Vy',
    'Nam',
    'Bao',
    'Kiet',
    'Nhi',
    'Phuc',
    'Duc',
    'Thao',
    'Trang',
    'Quan',
  ]
  const lastNames = [
    'Nguyen',
    'Tran',
    'Le',
    'Pham',
    'Hoang',
    'Vo',
    'Vu',
    'Do',
    'Bui',
    'Ngo',
    'Dang',
    'Huynh',
  ]

  const first = firstNames[index % firstNames.length]
  const last = lastNames[(index * 7) % lastNames.length]
  return `${first} ${last}`
}

function buildUsers(totalUsers: number) {
  return Array.from({ length: totalUsers }, (_, i) => {
    const n = i + 1
    const baseName = randomWorkspaceName(i)
    const displayName = `${baseName} ${pad(n)}`
    const emailBase = slugPart(`${baseName}.${pad(n)}`)
    const email = `${emailBase}@example.com`
    return {
      email,
      name: baseName,
      displayName,
      avatar: randomAvatar(email),
      joinedAt: randomJoinedAt(i),
    }
  })
}

async function seedWorkspaceUsers({
  workspaceId,
  channelId,
  totalUsers = DEFAULT_TOTAL_USERS,
  adminCount = DEFAULT_ADMIN_COUNT,
}: SeedOptions) {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is required')
  }

  const client = postgres(connectionString, {
    ssl: 'require',
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  })
  const db = drizzle(client, { schema })

  const [workspace] = await db
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1)

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`)
  }

  const [channel] = await db
    .select({
      id: schema.channels.id,
      workspaceId: schema.channels.workspaceId,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1)

  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`)
  }

  if (channel.workspaceId !== workspaceId) {
    throw new Error(
      `Channel ${channelId} does not belong to workspace ${workspaceId}`,
    )
  }

  const rows = buildUsers(totalUsers)
  const emails = rows.map((row) => row.email)

  const existingUsers = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.email, emails))

  const existingEmailToId = new Map(
    existingUsers.map((row) => [row.email.toLowerCase(), row.id]),
  )

  const usersToCreate = rows.filter(
    (row) => !existingEmailToId.has(row.email.toLowerCase()),
  )

  const insertedUsers: Array<{ id: string; email: string }> = []
  for (const row of usersToCreate) {
    const [created] = await db
      .insert(schema.users)
      .values({
        email: row.email,
        name: row.name,
        avatar: row.avatar,
      })
      .returning({ id: schema.users.id, email: schema.users.email })
    if (created) insertedUsers.push(created)
  }

  const allUsers = [...existingUsers, ...insertedUsers].sort((a, b) =>
    a.email.localeCompare(b.email),
  )

  const userIdByEmail = new Map(
    allUsers.map((row) => [row.email.toLowerCase(), row.id]),
  )

  const workspaceMemberRows = rows.map((row, index) => {
    const userId = userIdByEmail.get(row.email.toLowerCase())
    if (!userId) throw new Error(`Missing user id for ${row.email}`)
    return {
      workspaceId,
      userId,
      role: pickRole(index, adminCount) as 'owner' | 'admin' | 'member',
      email: row.email,
      name: row.name,
      displayName: row.displayName,
      avatar: row.avatar,
      isAway: false,
      joinedAt: row.joinedAt,
      statusText: null,
      statusEmoji: null,
      statusExpiration: null,
      notificationsPausedUntil: null,
    }
  })

  const existingMemberships = await db
    .select({
      userId: schema.workspaceMembers.userId,
    })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        inArray(
          schema.workspaceMembers.userId,
          workspaceMemberRows.map((row) => row.userId),
        ),
      ),
    )

  const existingMemberIds = new Set(
    existingMemberships.map((row) => row.userId),
  )
  const membershipsToInsert = workspaceMemberRows.filter(
    (row) => !existingMemberIds.has(row.userId),
  )

  if (membershipsToInsert.length > 0) {
    await db.insert(schema.workspaceMembers).values(membershipsToInsert)
  }

  const existingChannelMemberships = await db
    .select({
      userId: schema.channelMembers.userId,
    })
    .from(schema.channelMembers)
    .where(
      and(
        eq(schema.channelMembers.channelId, channelId),
        inArray(
          schema.channelMembers.userId,
          workspaceMemberRows.map((row) => row.userId),
        ),
      ),
    )

  const existingChannelUserIds = new Set(
    existingChannelMemberships.map((row) => row.userId),
  )
  const channelMembershipsToInsert = workspaceMemberRows
    .filter((row) => !existingChannelUserIds.has(row.userId))
    .map((row) => ({
      channelId,
      userId: row.userId,
      role: 'member' as const,
      joinedAt: row.joinedAt,
      lastReadAt: row.joinedAt,
      starredAt: null,
    }))

  if (channelMembershipsToInsert.length > 0) {
    await db.insert(schema.channelMembers).values(channelMembershipsToInsert)
  }

  const accountRows = rows.map((row) => {
    const userId = userIdByEmail.get(row.email.toLowerCase())
    if (!userId) throw new Error(`Missing user id for ${row.email}`)
    return {
      userId,
      provider: 'email',
      providerAccountId: row.email,
    }
  })

  const existingAccounts = await db
    .select({
      provider: schema.accounts.provider,
      providerAccountId: schema.accounts.providerAccountId,
    })
    .from(schema.accounts)
    .where(
      inArray(
        schema.accounts.providerAccountId,
        accountRows.map((row) => row.providerAccountId),
      ),
    )

  const existingAccountKeys = new Set(
    existingAccounts.map((row) => `${row.provider}:${row.providerAccountId}`),
  )
  const accountsToInsert = accountRows.filter(
    (row) =>
      !existingAccountKeys.has(`${row.provider}:${row.providerAccountId}`),
  )

  if (accountsToInsert.length > 0) {
    await db.insert(schema.accounts).values(accountsToInsert)
  }

  await client.end()

  return {
    workspaceId,
    channelId,
    requested: totalUsers,
    insertedUsers: usersToCreate.length,
    insertedWorkspaceMembers: membershipsToInsert.length,
    insertedChannelMembers: channelMembershipsToInsert.length,
    insertedAccounts: accountsToInsert.length,
    adminCount,
  }
}

async function main() {
  const [, , workspaceIdArg, channelIdArg, totalArg, adminArg] = process.argv

  const result = await seedWorkspaceUsers({
    workspaceId: workspaceIdArg ?? DEFAULT_WORKSPACE_ID,
    channelId: channelIdArg ?? DEFAULT_CHANNEL_ID,
    totalUsers: totalArg ? Number(totalArg) : DEFAULT_TOTAL_USERS,
    adminCount: adminArg ? Number(adminArg) : DEFAULT_ADMIN_COUNT,
  })

  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
