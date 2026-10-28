import { z } from 'zod'

/**
 * Schema cho finalize endpoint — client upload xong file,
 * gọi API này để update URL thật cho attachment row (match theo pendingUploadId).
 */
export const FinalizeAttachmentSchema = z.object({
  url: z.string().url('URL không hợp lệ'),
  mimeType: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  fileCategory: z.string().optional(),
})

export type FinalizeAttachmentDto = z.infer<typeof FinalizeAttachmentSchema>
