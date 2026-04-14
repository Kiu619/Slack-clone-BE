import { z } from 'zod'

export const AddChannelMemberSchema = z.object({
  userId: z.string().uuid('Invalid user id'),
})

export type AddChannelMemberDto = z.infer<typeof AddChannelMemberSchema>
