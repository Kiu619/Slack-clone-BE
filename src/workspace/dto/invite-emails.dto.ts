import { z } from 'zod'

export const InviteEmailsSchema = z.object({
  emails: z
    .array(z.string().email('Invalid email address'))
    .min(1)
    .max(50),
  /** Khi gửi từ dialog thêm người vào kênh — template email nhắc tên kênh */
  channelId: z.string().uuid().optional(),
})

export type InviteEmailsDto = z.infer<typeof InviteEmailsSchema>
