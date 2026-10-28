import { z } from 'zod'

export const localeSchema = z.enum(['en', 'vi'])
export const timeFormatSchema = z.enum(['12h', '24h'])
export const soundTypeSchema = z.enum([
  'none',
  'bell',
  'breeze',
  'boop',
  'chime',
  'click',
  'ding',
  'pop',
  'tap',
  'whoosh',
])

const weekDaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

const timeSchema = z.string().regex(/^\d{2}:\d{2}$/)

const availabilityDaySchema = z.object({
  day: weekDaySchema,
  startTime: timeSchema,
  endTime: timeSchema,
})

export const availabilityScheduleSchema = z
  .object({
    scheduleType: z.enum(['every_day', 'weekdays', 'custom']),
    startTime: timeSchema,
    endTime: timeSchema,
    days: z.array(availabilityDaySchema).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.scheduleType === 'custom') {
      if (!s.days || s.days.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Custom schedule must include at least one day',
          path: ['days'],
        })
      }
      // Per-day validation (each day's end > start)
      if (s.days) {
        s.days.forEach((d, i) => {
          if (d.startTime >= d.endTime) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'endTime must be greater than startTime',
              path: ['days', i, 'endTime'],
            })
          }
        })
      }
    } else {
      if (s.startTime >= s.endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endTime must be greater than startTime',
          path: ['endTime'],
        })
      }
    }
  })

export const UpdateMemberPreferencesSchema = z
  .object({
    locale: localeSchema.optional(),
    timeFormat: timeFormatSchema.optional(),
    desktopNotificationsEnabled: z.boolean().optional(),
    soundEnabled: z.boolean().optional(),
    messageSoundType: soundTypeSchema.optional(),
    // Also notify you about
    notifyOnThreadReply: z.boolean().optional(),
    notifyOnHuddle: z.boolean().optional(),
    huddleSoundType: soundTypeSchema.optional(),
    // Working hours / availability schedule (null to clear)
    availabilitySchedule: availabilityScheduleSchema.nullable().optional(),
  })
  .strict()

export type UpdateMemberPreferencesDto = z.infer<
  typeof UpdateMemberPreferencesSchema
>
