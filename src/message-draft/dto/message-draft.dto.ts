import { z } from 'zod'

const contextKeySchema = z.string().min(3).max(512)

export const UpsertMessageDraftSchema = z.object({
  contextKey: contextKeySchema,
  content: z.string().max(500_000).default(''),
})

export type UpsertMessageDraftDto = z.infer<typeof UpsertMessageDraftSchema>

export const DeleteMessageDraftQuerySchema = z.object({
  contextKey: contextKeySchema,
})

export type DeleteMessageDraftQueryDto = z.infer<
  typeof DeleteMessageDraftQuerySchema
>
