import { z } from 'zod'

export const UpdateGlobalSettingsSchema = z.object({
  notifyFor: z.enum(['all_messages', 'mentions_and_dm', 'nothing']).optional(),
  notifyOnHereMention: z.boolean().optional(),
  notifyOnChannelMention: z.boolean().optional(),
  dndEnabled: z.boolean().optional(),
  dndStartHour: z.number().min(0).max(23).optional(),
  dndEndHour: z.number().min(0).max(23).optional(),
  dndTimezone: z.string().optional(),
})

export type UpdateGlobalSettingsDto = z.infer<typeof UpdateGlobalSettingsSchema>

export const UpdateChannelOverrideSchema = z.object({
  workspaceId: z.string().optional(),
  channelId: z.string().optional(),
  conversationId: z.string().optional(),
  muteChannel: z.boolean().optional(),
  notifyFor: z.enum(['all_messages', 'mentions_and_dm', 'nothing']).optional(),
  mutedUntil: z.string().nullable().optional(),
})

export type UpdateChannelOverrideDto = z.infer<
  typeof UpdateChannelOverrideSchema
>
