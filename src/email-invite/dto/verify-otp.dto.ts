import { z } from 'zod'

/**
 * DTO cho POST /invites/:token/verify-otp.
 *
 * `code` phải đúng 6 chữ số.
 */
export const VerifyOtpSchema = z.object({
  code: z
    .string()
    .regex(/^\d{6}$/u, 'Code must be exactly 6 digits'),
})

export type VerifyOtpDto = z.infer<typeof VerifyOtpSchema>
