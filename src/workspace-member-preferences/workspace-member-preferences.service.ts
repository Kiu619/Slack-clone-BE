import { Inject, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  workspaceMemberPreferences,
  workspaceMembers,
  type WorkspaceMemberPreference,
} from '../database/schema'
import type { UpdateMemberPreferencesDto } from './dto/update-member-preferences.dto'

@Injectable()
export class WorkspaceMemberPreferencesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async getPreferences(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberPreference | null> {
    const [row] = await this.db
      .select()
      .from(workspaceMemberPreferences)
      .where(
        and(
          eq(workspaceMemberPreferences.workspaceId, workspaceId),
          eq(workspaceMemberPreferences.userId, userId),
        ),
      )
      .limit(1)

    return row ?? null
  }

  async upsertPreferences(
    workspaceId: string,
    userId: string,
    payload: UpdateMemberPreferencesDto,
  ): Promise<WorkspaceMemberPreference> {
    // Sync notification settings to workspaceMembers table for notification service
    const notificationFields: Record<string, unknown> = {}
    if (payload.notifyOnThreadReply !== undefined) {
      notificationFields.notifyOnThreadReply = payload.notifyOnThreadReply
    }
    if (payload.notifyOnHuddle !== undefined) {
      notificationFields.notifyOnHuddle = payload.notifyOnHuddle
    }

    // Update workspaceMembers if notification fields changed
    if (Object.keys(notificationFields).length > 0) {
      await this.db
        .update(workspaceMembers)
        .set(notificationFields)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
    }

    // Upsert preferences
    const [row] = await this.db
      .insert(workspaceMemberPreferences)
      .values({
        workspaceId,
        userId,
        ...payload,
      })
      .onConflictDoUpdate({
        target: [
          workspaceMemberPreferences.workspaceId,
          workspaceMemberPreferences.userId,
        ],
        set: {
          ...payload,
          updatedAt: new Date(),
        },
      })
      .returning()

    return row
  }
}
