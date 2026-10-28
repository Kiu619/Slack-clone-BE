import { z } from 'zod'

/**
 * DTO cho POST /invites/:token/accept.
 *
 * Token lấy từ URL param. Body chứa `name` (chỉ áp dụng cho nhánh nhập tay —
 * dùng làm default display name nếu user mới được tạo) và `timeZone` tuỳ chọn
 * để set cho workspace_member.
 *
 * `method` chỉ định nhánh:
 *   - 'otp':   user đã qua OTP, có thể chưa có account → BE tự tạo user.
 *   - 'oauth': user đã OAuth, BE check email match rồi insert member.
 *
 * Nếu thiếu `method`, mặc định là 'otp' (FE luôn truyền).
 */
export const AcceptInviteSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(60, 'Name must be at most 60 characters')
    .optional(),
  timeZone: z.string().trim().min(1).max(64).optional(),
  method: z.enum(['otp', 'oauth']).default('otp'),
})

export type AcceptInviteDto = z.infer<typeof AcceptInviteSchema>
