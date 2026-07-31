import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { workspaceMembers, workspacePermissions } from '../database/schema'
import {
  WORKSPACE_PERMISSION_CATALOG,
  type WorkspacePermissionKey,
  type WorkspacePermissionMatrix,
  type WorkspaceRoleKey,
  makePermissionMatrix,
} from './workspace-permissions.constants'

export type WorkspacePermissionRow = {
  id: string
  workspaceId: string
  permissionKey: WorkspacePermissionKey
  memberAllowed: boolean
  adminAllowed: boolean
  ownerAllowed: boolean
  primaryOwnerAllowed: boolean
  createdAt: Date
  updatedAt: Date
}

@Injectable()
export class WorkspacePermissionsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  private toRowFromMatrix(
    workspaceId: string,
    permissionKey: WorkspacePermissionKey,
    roles: WorkspacePermissionMatrix,
  ) {
    return {
      id: randomUUID(),
      workspaceId,
      permissionKey,
      memberAllowed: roles.member,
      adminAllowed: roles.admin,
      ownerAllowed: roles.owner,
      primaryOwnerAllowed: roles.primary_owner,
    }
  }

  private normalizeRow(row: {
    id?: string
    workspaceId: string
    permissionKey: string
    memberAllowed: boolean | null
    adminAllowed: boolean | null
    ownerAllowed: boolean | null
    primaryOwnerAllowed: boolean | null
    createdAt?: Date
    updatedAt?: Date
  }): WorkspacePermissionRow {
    return {
      id: row.id ?? randomUUID(),
      workspaceId: row.workspaceId,
      permissionKey: row.permissionKey as WorkspacePermissionKey,
      memberAllowed: row.memberAllowed ?? false,
      adminAllowed: row.adminAllowed ?? false,
      ownerAllowed: row.ownerAllowed ?? false,
      primaryOwnerAllowed: row.primaryOwnerAllowed ?? false,
      createdAt: row.createdAt ?? new Date(),
      updatedAt: row.updatedAt ?? new Date(),
    }
  }

  private catalogDefaultRows(workspaceId: string) {
    return WORKSPACE_PERMISSION_CATALOG.map((permission) =>
      this.toRowFromMatrix(
        workspaceId,
        permission.key,
        makePermissionMatrix(permission.defaultRoles),
      ),
    )
  }

  async seedWorkspacePermissions(workspaceId: string) {
    const rows = this.catalogDefaultRows(workspaceId)
    await this.db
      .insert(workspacePermissions)
      .values(rows)
      .onConflictDoNothing()
  }

  async getWorkspacePermissions(workspaceId: string) {
    await this.seedWorkspacePermissions(workspaceId)

    const rows = await this.db
      .select()
      .from(workspacePermissions)
      .where(eq(workspacePermissions.workspaceId, workspaceId))

    const byKey = new Map(
      rows.map((row) => [row.permissionKey as WorkspacePermissionKey, row]),
    )

    return WORKSPACE_PERMISSION_CATALOG.map((permission) => {
      const row = byKey.get(permission.key)
      if (!row) {
        return this.normalizeRow({
          workspaceId,
          permissionKey: permission.key,
          memberAllowed: permission.defaultRoles.member,
          adminAllowed: permission.defaultRoles.admin,
          ownerAllowed: permission.defaultRoles.owner,
          primaryOwnerAllowed: permission.defaultRoles.primary_owner,
        })
      }

      return this.normalizeRow({
        ...row,
        workspaceId: row.workspaceId,
        permissionKey: row.permissionKey,
      })
    })
  }

  async getPermissionRow(
    workspaceId: string,
    permissionKey: WorkspacePermissionKey,
  ) {
    await this.seedWorkspacePermissions(workspaceId)

    const [row] = await this.db
      .select()
      .from(workspacePermissions)
      .where(
        and(
          eq(workspacePermissions.workspaceId, workspaceId),
          eq(workspacePermissions.permissionKey, permissionKey),
        ),
      )
      .limit(1)

    if (!row) {
      const permission = WORKSPACE_PERMISSION_CATALOG.find(
        (item) => item.key === permissionKey,
      )
      if (!permission) return null
      return this.normalizeRow({
        workspaceId,
        permissionKey,
        memberAllowed: permission.defaultRoles.member,
        adminAllowed: permission.defaultRoles.admin,
        ownerAllowed: permission.defaultRoles.owner,
        primaryOwnerAllowed: permission.defaultRoles.primary_owner,
      })
    }

    return this.normalizeRow({
      ...row,
      workspaceId: row.workspaceId,
      permissionKey: row.permissionKey,
    })
  }

  async updateWorkspacePermission(
    workspaceId: string,
    permissionKey: WorkspacePermissionKey,
    roles: WorkspacePermissionMatrix,
  ) {
    const permission = await this.getPermissionRow(workspaceId, permissionKey)
    if (!permission) {
      throw new ForbiddenException('Permission row not found')
    }

    const [updated] = await this.db
      .update(workspacePermissions)
      .set({
        memberAllowed: roles.member,
        adminAllowed: roles.admin,
        ownerAllowed: roles.owner,
        primaryOwnerAllowed: roles.primary_owner,
      })
      .where(
        and(
          eq(workspacePermissions.workspaceId, workspaceId),
          eq(workspacePermissions.permissionKey, permissionKey),
        ),
      )
      .returning()

    return this.normalizeRow(updated ?? permission)
  }

  private hasRoleAccess(
    row: {
      memberAllowed: boolean
      adminAllowed: boolean
      ownerAllowed: boolean
      primaryOwnerAllowed: boolean
    },
    role: WorkspaceRoleKey,
  ) {
    return role === 'member'
      ? row.memberAllowed
      : role === 'admin'
        ? row.adminAllowed
        : role === 'owner'
          ? row.ownerAllowed
          : row.primaryOwnerAllowed
  }

  async getWorkspaceMembership(
    workspaceId: string,
    userId: string,
  ): Promise<{
    id: string
    role: WorkspaceRoleKey
    membershipStatus: 'active' | 'deactivated'
  } | null> {
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

    if (!membership) return null

    return {
      id: membership.id,
      role: membership.role,
      membershipStatus: membership.membershipStatus,
    }
  }

  async canUser(
    workspaceId: string,
    userId: string,
    permissionKey: WorkspacePermissionKey,
  ) {
    const membership = await this.getWorkspaceMembership(workspaceId, userId)
    if (!membership || membership.membershipStatus !== 'active') {
      return false
    }

    const row = await this.getPermissionRow(workspaceId, permissionKey)
    if (!row) return false

    return this.hasRoleAccess(
      {
        memberAllowed: row.memberAllowed,
        adminAllowed: row.adminAllowed,
        ownerAllowed: row.ownerAllowed,
        primaryOwnerAllowed: row.primaryOwnerAllowed,
      },
      membership.role,
    )
  }

  async requireUserPermission(
    workspaceId: string,
    userId: string,
    permissionKey: WorkspacePermissionKey,
  ) {
    const allowed = await this.canUser(workspaceId, userId, permissionKey)
    if (!allowed) {
      throw new ForbiddenException(
        'You do not have permission to perform this action',
      )
    }
  }
}
