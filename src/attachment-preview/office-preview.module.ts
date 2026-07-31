import { Module } from '@nestjs/common'
import { UploadModule } from '../upload/upload.module'
import { OfficeThumbnailGeneratorService } from './office-thumbnail-generator.service'

@Module({
  imports: [UploadModule],
  providers: [OfficeThumbnailGeneratorService],
  exports: [OfficeThumbnailGeneratorService],
})
export class OfficePreviewModule {}
