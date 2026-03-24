import { z } from 'zod'

export const UpdateContactSchema = z.object({
  phone: z
    .string()
    .max(30, 'Phone number must be at most 30 characters')
    .optional()
    .nullable(),
})

export type UpdateContactDto = z.infer<typeof UpdateContactSchema>
