import { z } from 'zod'

/**
 * DTO cho request presigned URL (S3 hoặc Cloudinary)
 */
export const PresignedUrlRequestSchema = z.object({
  fileName: z
    .string()
    .min(1, 'File name không được để trống')
    .max(255, 'File name quá dài'),
  fileType: z.string().min(1, 'File type không được để trống'),
  fileSize: z
    .number()
    .int()
    .positive('File size phải > 0')
    .max(100 * 1024 * 1024, 'File quá lớn (max 100MB)'),
})

export type PresignedUrlRequestDto = z.infer<typeof PresignedUrlRequestSchema>
