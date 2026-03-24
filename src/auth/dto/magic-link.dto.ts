import { z } from 'zod'
import {
  isValidTimeZoneValue,
} from '../../common/constants/timezone.constants'

export const MagicLinkSchema = z.object({
  email: z.email('Invalid email address'),
})

export type MagicLinkDto = z.infer<typeof MagicLinkSchema>

export const MagicLinkVerifySchema = z.object({
  token: z.string().min(1, 'Token is required'),
  timeZone: z
    .string()
    .refine((v) => !v || isValidTimeZoneValue(v), {
      message: 'Invalid timezone value',
    })
    .optional(),
})

export type MagicLinkVerifyDto = z.infer<typeof MagicLinkVerifySchema>
