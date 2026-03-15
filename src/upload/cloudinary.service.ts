import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { v2 as cloudinary } from 'cloudinary'
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
   * Parse Cloudinary URL để lấy public_id (dùng cho delete)
   */
  extractPublicId(url: string): string | null {
    const match = url.match(/\/v\d+\/(.+)\.\w+$/)
    return match ? match[1] : null
  }

  /**
   * Delete file từ Cloudinary (dùng khi xóa attachment)
   */
  async deleteFile(publicId: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicId)
      this.logger.log(`Deleted file from Cloudinary: ${publicId}`)
    } catch (error) {
      this.logger.error(`Failed to delete file: ${publicId}`, error)
    }
  }
}
