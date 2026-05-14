import { z } from 'zod'

export const AddConversationMembersSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(8),
})

export type AddConversationMembersDto = z.infer<
  typeof AddConversationMembersSchema
>
