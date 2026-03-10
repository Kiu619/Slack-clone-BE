import { Module } from '@nestjs/common'
import { CloudinaryService } from './cloudinary.service'
import { S3Service } from './s3.service'
import { UploadController } from './upload.controller'

@Module({
  controllers: [UploadController],
  providers: [S3Service, CloudinaryService],
  exports: [S3Service, CloudinaryService],
})
export class UploadModule {}
