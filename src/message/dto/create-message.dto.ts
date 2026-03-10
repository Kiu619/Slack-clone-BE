import { z } from 'zod'

export const CreateMessageSchema = z.object({
  content: z
    .string()
    .min(1, 'Nội dung không được để trống')
    .max(40000, 'Tin nhắn quá dài (tối đa 40,000 ký tự)'),
  /** parentId: nếu có → reply trong thread */
  parentId: z.string().optional(),
})

export type CreateMessageDto = z.infer<typeof CreateMessageSchema>

export const UpdateMessageSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(40000),
})

export type UpdateMessageDto = z.infer<typeof UpdateMessageSchema>

export const AddReactionSchema = z.object({
  /** emoji: unicode string ví dụ "👍" */
  emoji: z.string().min(1).max(10),
})

export type AddReactionDto = z.infer<typeof AddReactionSchema>
