import { z } from 'zod'
import { getChannelNameError } from '../channel-slug.util'

const nameSchema = z.string().superRefine((v, ctx) => {
  const message = getChannelNameError(v)
  if (message !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
    })
  }
})

export const UpdateChannelSchema = z
  .object({
    name: nameSchema.optional(),
    isPrivate: z.boolean().optional(),
    topic: z.string().max(500).nullable().optional(),
    description: z.string().max(250).nullable().optional(),
    postingSettings: z
      .object({
        mode: z.enum(['everyone', 'admin_only', 'admins_plus_specific_people']),
        allowThreads: z.boolean(),
        allowMentions: z.boolean(),
        specificUserIds: z.array(z.string().uuid()).default([]),
      })
      .superRefine((value, ctx) => {
        const uniqueIds = new Set(value.specificUserIds)

        if (uniqueIds.size !== value.specificUserIds.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['specificUserIds'],
            message: 'Duplicate specific users are not allowed',
          })
        }

        if (value.mode === 'admins_plus_specific_people') {
          if (value.specificUserIds.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['specificUserIds'],
              message:
                'Select at least one specific person when using this mode',
            })
          }
          return
        }

        if (value.specificUserIds.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['specificUserIds'],
            message:
              'Specific people can only be set when using admins plus specific people',
          })
        }
      })
      .nullable()
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  })

export type UpdateChannelDto = z.infer<typeof UpdateChannelSchema>
