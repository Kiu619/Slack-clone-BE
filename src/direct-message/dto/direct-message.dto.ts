import { z } from 'zod'

export const CreateDirectMessageSchema = z.object({
  workspaceId: z.uuid(),
  userIds: z.array(z.string().uuid()).min(1).max(8), // Không bao gồm bản thân, tối đa 8 người khác (tổng 9)
})

export type CreateDirectMessageDto = z.infer<typeof CreateDirectMessageSchema>
