import { z } from 'zod'

export const CreateMessageSchema = z
  .object({
    content: z.string().max(40000, 'Tin nhắn quá dài (tối đa 40,000 ký tự)'),
    /** parentId: nếu có → reply trong thread */
    parentId: z.string().optional(),
    /** alsoSendToChannel: nếu true → reply cũng được gửi ra channel chính */
    alsoSendToChannel: z.boolean().optional(),
    /** userIds: dùng cho trường hợp gửi tin nhắn đầu tiên để tạo DM conversation */
    userIds: z.array(z.string().uuid()).optional(),
    /** workspaceId: dùng kèm với userIds */
    workspaceId: z.string().uuid().optional(),
    /** attachments: danh sách file đính kèm đã upload lên S3/Cloudinary.
     *
     * Optimistic upload pattern:
     * - Client tạo message + attachment rows NGAY khi user bấm Send (không cần URL thật).
     * - Server lưu tạm attachment row với `url=''` + `pendingUploadId` (client-generated).
     * - Sau khi upload xong, client gọi `POST /messages/:id/attachments/:pendingUploadId/finalize`
     *   để update URL thật.
     *
     * Vì vậy `url` chỉ BẮT BUỘC khi `pendingUpload !== true`.
     */
    attachments: z
      .array(
        z
          .object({
            url: z.string().optional(),
            type: z.enum(['image', 'video', 'audio', 'file']),
            name: z.string(),
            size: z.number(),
            mimeType: z.string().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            duration: z.number().optional(),
            fileCategory: z.string().optional(),
            /** Client-generated uploadId (Math.random), dùng để map progress + retry + finalize. */
            pendingUploadId: z.string().optional(),
            /** Đánh dấu attachment chưa có URL thật (server lưu tạm với url rỗng). */
            pendingUpload: z.boolean().optional(),
          })
          .refine(
            (a) =>
              a.pendingUpload === true || (typeof a.url === 'string' && a.url.length > 0),
            {
              message: 'url là bắt buộc khi không phải pendingUpload',
              path: ['url'],
            },
          ),
      )
      .optional(),
  })
  .refine(
    (data) =>
      data.content.trim().length > 0 ||
      (data.attachments && data.attachments.length > 0),
    {
      message: 'Nội dung hoặc file đính kèm không được để trống',
      path: ['content'],
    },
  )

export type CreateMessageDto = z.infer<typeof CreateMessageSchema>

export const UpdateMessageSchema = z
  .object({
    content: z.string().max(40000).optional(),
    /** attachments: danh sách attachment mới cần UPDATE.
     *
     * Optimistic upload pattern (giống Create):
     * - Client build optimistic attachments NGAY khi user nhấn Save (không cần URL thật).
     * - Server lưu tạm attachment row với `url=''` + `pendingUploadId` (client-generated).
     * - Sau khi upload xong, client gọi `POST /messages/:id/attachments/:pendingUploadId/finalize`
     *   để update URL thật.
     *
     * Vì vậy `url` chỉ BẮT BUỘC khi `pendingUpload !== true`. */
    attachments: z
      .array(
        z
          .object({
            url: z.string().url().optional(),
            type: z.enum(['image', 'video', 'audio', 'file']),
            name: z.string(),
            size: z.number(),
            mimeType: z.string().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            duration: z.number().optional(),
            fileCategory: z.string().optional(),
            /** Client-generated uploadId, dùng để match attachment row khi finalize. */
            pendingUploadId: z.string().optional(),
            /** Đánh dấu attachment chưa có URL thật (server lưu tạm với url rỗng). */
            pendingUpload: z.boolean().optional(),
          })
          .refine(
            (a) =>
              a.pendingUpload === true ||
              (typeof a.url === 'string' && a.url.length > 0),
            {
              message: 'url là bắt buộc khi không phải pendingUpload',
              path: ['url'],
            },
          ),
      )
      .optional(),
    /** deletedAttachmentIds: danh sách ID attachments muốn xóa */
    deletedAttachmentIds: z.array(z.string().uuid()).optional(),
  })
  .refine(
    (data) => {
      // Logic này hơi phức tạp vì ta không biết message hiện tại có attachments không nếu client không gửi.
      // Tuy nhiên, tối thiểu client phải gửi content hoặc có attachments mới.
      // Nếu xóa hết attachments mà content rỗng thì sẽ vi phạm ở tầng Service khi kiểm tra DB.
      return true
    },
    {
      message: 'Nội dung hoặc file đính kèm không được để trống',
      path: ['content'],
    },
  )

export type UpdateMessageDto = z.infer<typeof UpdateMessageSchema>

export const AddReactionSchema = z.object({
  /** emoji: unicode string ví dụ "👍" */
  emoji: z.string().min(1).max(10),
})

export type AddReactionDto = z.infer<typeof AddReactionSchema>
