import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, join } from 'path'
import { promisify } from 'util'
import { execFile } from 'child_process'
import { CloudinaryService } from '../upload/cloudinary.service'
import { S3Service } from '../upload/s3.service'

const execFileAsync = promisify(execFile)

type PreviewableAttachment = {
  id: string
  workspaceId: string
  name: string
  url: string
}

export class OfficeThumbnailError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

@Injectable()
export class OfficeThumbnailGeneratorService {
  private readonly logger = new Logger(OfficeThumbnailGeneratorService.name)

  constructor(
    private readonly configService: ConfigService,
    private readonly s3Service: S3Service,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async generateThumbnail(
    attachment: PreviewableAttachment,
  ): Promise<{ previewImageUrl: string }> {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'office-preview-'))

    try {
      const sourceUrl = await this.resolveSourceUrl(
        attachment.url,
        attachment.name,
      )
      const sourcePath = await this.downloadSourceFile(
        tempDir,
        attachment.name,
        sourceUrl,
      )
      const pdfPath = await this.convertOfficeFileToPdf(tempDir, sourcePath)
      const uploadResult = await this.cloudinaryService.uploadOfficePreviewPdf(
        pdfPath,
        attachment.id,
        attachment.workspaceId,
      )

      return { previewImageUrl: uploadResult.thumbnailUrl }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  }

  private async resolveSourceUrl(url: string, fileName: string) {
    const s3Key = this.s3Service.parseS3KeyFromUrl(url)
    if (!s3Key) return url

    return this.s3Service.getPresignedGetUrl(s3Key, 3600, fileName)
  }

  private async downloadSourceFile(
    tempDir: string,
    fileName: string,
    url: string,
  ): Promise<string> {
    const ext = extname(fileName) || ''
    const sourcePath = join(tempDir, `source${ext}`)
    const response = await fetch(url)

    if (!response.ok) {
      throw new OfficeThumbnailError(
        'source_download_failed',
        `Failed to download source file: ${response.status}`,
      )
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(sourcePath, buffer)

    return sourcePath
  }

  private async convertOfficeFileToPdf(
    tempDir: string,
    sourcePath: string,
  ): Promise<string> {
    const converter = await this.resolveLibreOfficeBinary()
    const sourceBaseName = basename(sourcePath, extname(sourcePath))
    const pdfPath = join(tempDir, `${sourceBaseName}.pdf`)

    try {
      await execFileAsync(
        converter,
        ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, sourcePath],
        {
          timeout: 120000,
          windowsHide: true,
        },
      )
    } catch (error) {
      this.logger.error(`LibreOffice convert failed for ${sourcePath}`, error)
      throw new OfficeThumbnailError(
        'conversion_failed',
        'LibreOffice could not convert the Office file to PDF.',
      )
    }

    try {
      await fs.access(pdfPath)
      return pdfPath
    } catch {
      throw new OfficeThumbnailError(
        'pdf_not_generated',
        'Office preview PDF was not generated.',
      )
    }
  }

  private async resolveLibreOfficeBinary(): Promise<string> {
    const configuredBinary = this.configService.get<string>('LIBREOFFICE_BIN')
    const candidates = [configuredBinary, 'soffice', 'libreoffice'].filter(
      (value): value is string => !!value,
    )

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version'], {
          timeout: 10000,
          windowsHide: true,
        })
        return candidate
      } catch {
        continue
      }
    }

    throw new OfficeThumbnailError(
      'converter_unavailable',
      'LibreOffice binary is not available on this worker.',
    )
  }
}
