import { z } from 'zod'

export const InviteEmailsSchema = z.object({
  emails: z.array(z.string().email('Invalid email address')).min(1).max(50),
  /**
   * Nhiều channel — mỗi email × mỗi channelId tạo 1 row invite riêng.
   * Optional = chỉ mời workspace (không auto-add vào channel nào).
   */
  channelIds: z.array(z.string().uuid()).max(20).optional(),
})

export type InviteEmailsDto = z.infer<typeof InviteEmailsSchema>
