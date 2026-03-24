import { z } from 'zod'

const optionalString = z.union([z.string(), z.undefined(), z.null()])
const optionalUrl = z.union([z.string().url(), z.undefined(), z.null()])

export const UpdateProfileSchema = z
  .object({
    name: z
      .string()
      .min(5, 'Name must be at least 5 characters')
      .max(32, 'Name must be at most 32 characters'),
    displayName: optionalString.refine(
      (val) =>
        !val ||
        typeof val !== 'string' ||
        val.length === 0 ||
        (val.length >= 2 && val.length <= 50),
      { message: 'Display name must be 2–50 characters when provided.' },
    ),
    namePronunciation: z
      .string()
      .max(50, 'Name pronunciation must be at most 50 characters')
      .optional()
      .nullable(),
    timeZone: optionalString,
    avatar: optionalUrl,
    isAway: z.boolean().optional(),
    status: optionalString,
  })
  .partial()

export type UpdateProfileDto = z.infer<typeof UpdateProfileSchema>
