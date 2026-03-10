import { z } from 'zod'

/**
 * DTO để tạo attachment sau khi upload file lên S3/Cloudinary
 */
export const CreateAttachmentSchema = z.object({
  messageId: z.string().uuid('messageId phải là UUID'),
  url: z.string().url('url không hợp lệ'),
  type: z.enum(['image', 'video', 'audio', 'file']),
  name: z.string().min(1, 'name không được để trống').max(255),
  size: z.number().int().positive('size phải > 0'),
  mimeType: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().positive().optional(),
})

export type CreateAttachmentDto = z.infer<typeof CreateAttachmentSchema>
