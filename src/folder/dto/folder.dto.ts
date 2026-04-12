import { z } from 'zod'

export const CreateFolderSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Folder name must be at least 2 characters')
    .max(80, 'Folder name must be at most 80 characters')
    .regex(
      /^[a-z0-9-_]+$/,
      'Folder name can only contain lowercase letters, numbers, hyphens and underscores',
    ),
})

export const RenameFolderSchema = CreateFolderSchema

export const AddAttachmentToFolderSchema = z.object({
  attachmentId: z.string().min(1),
})

/**
 * Sau khi client upload lên S3/Cloudinary — tạo message ẩn + attachment + folder link.
 * Giống CreateAttachmentSchema nhưng không cần messageId.
 */
export const UploadFileToFolderSchema = z.object({
  url: z.string().url('url không hợp lệ'),
  type: z.enum(['image', 'video', 'audio', 'file']),
  name: z.string().min(1, 'name không được để trống').max(255),
  size: z.number().int().positive('size phải > 0'),
  mimeType: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().positive().optional(),
})

export type CreateFolderDto = z.infer<typeof CreateFolderSchema>
export type RenameFolderDto = z.infer<typeof RenameFolderSchema>
export type AddAttachmentToFolderDto = z.infer<
  typeof AddAttachmentToFolderSchema
>
export type UploadFileToFolderDto = z.infer<typeof UploadFileToFolderSchema>
