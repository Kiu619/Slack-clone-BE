import { z } from 'zod'

/**
 * DTO cho POST /invites/:token/send-otp.
 *
 * Body gần như rỗng — controller lấy token từ URL param và lookup email từ
 * bảng `workspace_email_invites`. Chỉ verify rate-limit + lookup.
 */
export const SendOtpSchema = z.object({})

export type SendOtpDto = z.infer<typeof SendOtpSchema>
