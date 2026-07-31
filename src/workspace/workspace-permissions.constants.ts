export const WORKSPACE_ROLE_KEYS = [
  'member',
  'admin',
  'owner',
  'primary_owner',
] as const

export type WorkspaceRoleKey = (typeof WORKSPACE_ROLE_KEYS)[number]

export type WorkspacePermissionMatrix = Record<WorkspaceRoleKey, boolean>

const ALL_TRUE: WorkspacePermissionMatrix = {
  member: true,
  admin: true,
  owner: true,
  primary_owner: true,
}

const ADMIN_PLUS: WorkspacePermissionMatrix = {
  member: false,
  admin: true,
  owner: true,
  primary_owner: true,
}

const OWNER_PLUS: WorkspacePermissionMatrix = {
  member: false,
  admin: false,
  owner: true,
  primary_owner: true,
}

export const WORKSPACE_PERMISSION_CATALOG = [
  {
    key: 'add_and_edit_custom_emoji',
    label: 'Add and edit custom emoji',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'allow_profile_photo_edits',
    label: 'Allow profile photo edits',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'archive_channels',
    label: 'Archive channels',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'convert_private_channels_to_public',
    label: 'Convert private channels to public',
    defaultRoles: OWNER_PLUS,
  },
  {
    key: 'convert_public_channels_to_private',
    label: 'Convert public channels to private',
    defaultRoles: ADMIN_PLUS,
  },
  {
    key: 'create_private_channels',
    label: 'Create private channels',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'create_public_channels',
    label: 'Create public channels',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'delete_channels',
    label: 'Delete channels',
    defaultRoles: ADMIN_PLUS,
  },
  {
    key: 'delete_custom_emoji',
    label: 'Delete custom emoji',
    defaultRoles: ADMIN_PLUS,
  },
  {
    key: 'delete_messages_from_apps_bots',
    label: 'Delete messages from apps/bots',
    defaultRoles: ADMIN_PLUS,
  },
  {
    key: 'delete_own_messages',
    label: 'Delete own messages',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'edit_channel_posting_permissions',
    label: 'Edit channel posting permissions',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'manage_user_permissions',
    label: 'Manage user permissions',
    defaultRoles: ADMIN_PLUS,
  },
  {
    key: 'remove_users_from_private_channels',
    label: 'Remove users from private channels',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'remove_users_from_public_channels',
    label: 'Remove users from public channels',
    defaultRoles: ADMIN_PLUS,
  },
  {
    key: 'unarchive_channels',
    label: 'Unarchive channels',
    defaultRoles: ADMIN_PLUS,
  },
  {
    key: 'update_display_name',
    label: 'Update display name',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'update_name',
    label: 'Update name',
    defaultRoles: ALL_TRUE,
  },
  {
    key: 'use_channel_and_here_in_channels',
    label: 'Use @channel and @here in channels',
    defaultRoles: ALL_TRUE,
  },
] as const

export type WorkspacePermissionKey =
  (typeof WORKSPACE_PERMISSION_CATALOG)[number]['key']

export function makePermissionMatrix(
  overrides?: Partial<WorkspacePermissionMatrix>,
): WorkspacePermissionMatrix {
  return {
    member: overrides?.member ?? false,
    admin: overrides?.admin ?? false,
    owner: overrides?.owner ?? false,
    primary_owner: overrides?.primary_owner ?? false,
  }
}
