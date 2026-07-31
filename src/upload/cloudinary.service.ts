import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { v2 as cloudinary } from 'cloudinary'

type CloudinaryResourceType = 'image' | 'video' | 'raw'

type CloudinaryDeleteTarget = {
  publicId: string
  resourceType: CloudinaryResourceType
}

@Injectable()
export class CloudinaryService implements OnModuleInit {
  private readonly logger = new Logger(CloudinaryService.name)
  private cloudName: string

  /** Max file size cho image: 10MB, video: 100MB */
  private readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024
  private readonly MAX_VIDEO_SIZE = 100 * 1024 * 1024

  constructor(private config: ConfigService) {}

  onModuleInit() {
    this.cloudName = this.config.getOrThrow<string>('CLOUDINARY_CLOUD_NAME')
    const apiKey = this.config.getOrThrow<string>('CLOUDINARY_API_KEY')
    const apiSecret = this.config.getOrThrow<string>('CLOUDINARY_API_SECRET')

    cloudinary.config({
      cloud_name: this.cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    })

    this.logger.log(`CloudinaryService initialized: cloud=${this.cloudName}`)
  }

  /**
   * Generate upload signature cho client upload trực tiếp lên Cloudinary
   *
   * Theo Cloudinary docs: params signed phải khớp CHÍNH XÁC với params gửi lên.
   * - public_id: chỉ phần unique (không bao gồm folder) → Cloudinary lưu tại folder/public_id
   * - Chỉ sign các params tối thiểu: timestamp, folder, public_id
   *
   * @param fileName - Tên file gốc (e.g., "avatar.png")
   * @param fileType - MIME type (e.g., "image/png", "video/mp4")
   * @param fileSize - Size tính bằng bytes
   * @returns { signature, timestamp, cloudName, apiKey, folder, publicId }
   */
  generateUploadSignature(
    fileName: string,
    fileType: string,
    fileSize: number,
  ): {
    signature: string
    timestamp: number
    cloudName: string
    apiKey: string
    folder: string
    publicId: string
  } {
    // Validate size
    const isImage = fileType.startsWith('image/')
    const isVideo = fileType.startsWith('video/')

    if (isImage && fileSize > this.MAX_IMAGE_SIZE) {
      throw new Error(`Image quá lớn. Max: 10MB`)
    }
    if (isVideo && fileSize > this.MAX_VIDEO_SIZE) {
      throw new Error(`Video quá lớn. Max: 100MB`)
    }

    const timestamp = Math.round(Date.now() / 1000)
    const uuid = Math.random().toString(36).substring(2, 15)
    const folder = isImage ? 'slack/images' : 'slack/videos'
    // Chỉ dùng uuid — Cloudinary lưu tại folder/public_id (không trùng folder)
    const publicId = uuid

    // Chỉ sign các params sẽ gửi trong FormData (theo thứ tự alphabet)
    const paramsToSign = {
      folder,
      public_id: publicId,
      timestamp,
    }

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      this.config.getOrThrow<string>('CLOUDINARY_API_SECRET'),
    )

    this.logger.log(`Generated Cloudinary signature for: ${fileName}`)

    return {
      signature,
      timestamp,
      cloudName: this.cloudName,
      apiKey: this.config.getOrThrow<string>('CLOUDINARY_API_KEY'),
      folder,
      publicId,
    }
  }

  /**
   * Parse Cloudinary URL để lấy public_id + resource type (dùng cho delete).
   * Hỗ trợ cả image/video upload URL và bỏ qua query string.
   */
  extractDeleteTarget(url: string): CloudinaryDeleteTarget | null {
    try {
      const parsed = new URL(url)
      const segments = parsed.pathname.split('/').filter(Boolean)
      const cloudNameIndex = segments.indexOf(this.cloudName)

      if (cloudNameIndex < 0) return null

      const resourceType = segments[
        cloudNameIndex + 1
      ] as CloudinaryResourceType
      const action = segments[cloudNameIndex + 2]
      if (
        !['image', 'video', 'raw'].includes(resourceType) ||
        action !== 'upload'
      ) {
        return null
      }

      const versionIndex = cloudNameIndex + 3
      const version = segments[versionIndex]
      if (!version?.startsWith('v')) return null

      const encodedPublicId = segments.slice(versionIndex + 1).join('/')
      if (!encodedPublicId) return null

      const publicId = encodedPublicId.replace(/\.[^.]+$/, '')
      return { publicId, resourceType }
    } catch {
      return null
    }
  }

  /**
   * Parse Cloudinary URL để lấy public_id (dùng cho code cũ)
   */
  extractPublicId(url: string): string | null {
    return this.extractDeleteTarget(url)?.publicId ?? null
  }

  /**
   * Delete file từ Cloudinary (dùng khi xóa attachment)
   */
  async deleteFile(
    publicId: string,
    resourceType: CloudinaryResourceType = 'image',
  ): Promise<boolean> {
    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        invalidate: true,
      })

      if (result?.result === 'ok') {
        this.logger.log(
          `Deleted file from Cloudinary: ${resourceType}/${publicId}`,
        )
        return true
      }

      if (result?.result === 'not found') {
        this.logger.warn(
          `Cloudinary file already missing: ${resourceType}/${publicId}`,
        )
        return false
      }

      this.logger.warn(
        `Cloudinary delete returned unexpected result for ${resourceType}/${publicId}: ${JSON.stringify(result)}`,
      )
      return false
    } catch (error) {
      this.logger.error(
        `Failed to delete file from Cloudinary: ${resourceType}/${publicId}`,
        error,
      )
      throw error
    }
  }

  async uploadOfficePreviewPdf(
    filePath: string,
    attachmentId: string,
    workspaceId: string,
  ): Promise<{ publicId: string; thumbnailUrl: string }> {
    const uploadResult = await cloudinary.uploader.upload(filePath, {
      resource_type: 'image',
      format: 'pdf',
      folder: `slack/office-previews/${workspaceId}`,
      public_id: attachmentId,
      overwrite: true,
      use_filename: false,
      unique_filename: false,
    })

    const publicId = uploadResult.public_id
    const thumbnailUrl = cloudinary.url(publicId, {
      secure: true,
      resource_type: 'image',
      format: 'jpg',
      page: '1',
      transformation: [
        {
          width: 1200,
          crop: 'limit',
          quality: 'auto:good',
          fetch_format: 'auto',
        },
      ],
    })

    return { publicId, thumbnailUrl }
  }
}
