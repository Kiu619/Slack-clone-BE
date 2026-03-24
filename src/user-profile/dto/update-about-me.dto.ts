import { z } from 'zod'

export const UpdateAboutMeSchema = z.object({
  description: z
    .string()
    .max(2000, 'Description must be at most 2000 characters')
    .optional()
    .nullable(),
})

export type UpdateAboutMeDto = z.infer<typeof UpdateAboutMeSchema>
