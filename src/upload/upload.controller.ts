import { Body, Controller, Post, UseGuards, UsePipes } from '@nestjs/common'
import { CloudinaryService } from './cloudinary.service'
import {
  type PresignedUrlRequestDto,
  PresignedUrlRequestSchema,
} from './dto/presigned-url.dto'
import { S3Service } from './s3.service'
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from 'src/common/pipes/zod-validation.pipe'

/**
 * UploadController — Endpoints để generate presigned URLs
 *
 * Không nhận file upload trực tiếp (để tránh tải server)
 * Chỉ generate presigned URL cho client upload trực tiếp lên S3/Cloudinary
 */
@Controller('upload')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(
    private s3Service: S3Service,
    private cloudinaryService: CloudinaryService,
  ) {}

  /**
   * POST /upload/presigned-url/s3
   * Generate presigned URL cho S3 (dùng cho files: PDF, DOC, ZIP...)
   */
  @Post('presigned-url/s3')
  @UsePipes(new ZodValidationPipe(PresignedUrlRequestSchema))
  async getS3PresignedUrl(@Body() dto: PresignedUrlRequestDto) {
    const { url, key, expiresIn } = await this.s3Service.generatePresignedUrl(
      dto.fileName,
      dto.fileType,
      dto.fileSize,
    )

    return {
      url,
      key,
      expiresIn,
      // publicUrl sẽ dùng sau khi upload xong
      publicUrl: this.s3Service.getPublicUrl(key),
    }
  }

  /**
   * POST /upload/presigned-url/cloudinary
   * Generate signature cho Cloudinary (dùng cho image/video)
   */
  @Post('presigned-url/cloudinary')
  @UsePipes(new ZodValidationPipe(PresignedUrlRequestSchema))
  getCloudinarySignature(@Body() dto: PresignedUrlRequestDto) {
    const { signature, timestamp, cloudName, apiKey, folder, publicId } =
      this.cloudinaryService.generateUploadSignature(
        dto.fileName,
        dto.fileType,
        dto.fileSize
      )

    return {
      signature,
      timestamp,
      cloudName,
      apiKey,
      folder,
      publicId,
      // Upload URL của Cloudinary
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
    }
  }
}
