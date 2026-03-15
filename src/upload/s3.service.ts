import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID } from 'crypto'

/**
 * S3Service — Quản lý upload file lên AWS S3
 *
 * Flow:
 * 1. Client gọi POST /upload/presigned-url/s3 với { fileName, fileType, fileSize }
 * 2. Backend validate → generate presigned PUT URL (TTL 5 phút)
 * 3. Client upload trực tiếp lên S3 qua presigned URL (không qua server)
 * 4. Client gọi POST /attachments với { url, name, size, type } để lưu metadata vào DB
 *
 * Lợi ích:
 * - Giảm tải cho backend (không cần stream file qua server)
 * - Upload nhanh hơn (direct to S3)
 * - Progress tracking dễ dàng (axios onUploadProgress)
 */
@Injectable()
export class S3Service implements OnModuleInit {
  private readonly logger = new Logger(S3Service.name)
  private s3Client: S3Client
  private bucketName: string
  private folderPrefix: string

  /** Max file size: 50MB */
  private readonly MAX_FILE_SIZE = 50 * 1024 * 1024

  /** Allowed file extensions (không bao gồm image/video — dùng Cloudinary) */
  private readonly ALLOWED_EXTENSIONS = [
    // Documents
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.txt',
    '.csv',
    // Archives
    '.zip',
    '.rar',
    '.7z',
    '.tar',
    '.gz',
    // Code
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.py',
    '.java',
    '.cpp',
    '.c',
    '.go',
    '.rs',
    '.json',
    '.xml',
    '.yaml',
    '.yml',
    // Audio (nếu không dùng Cloudinary)
    '.mp3',
    '.wav',
    '.ogg',
    '.m4a',
  ]

  constructor(private config: ConfigService) {}

  onModuleInit() {
    const region = this.config.getOrThrow<string>('AWS_REGION')
    const accessKeyId = this.config.getOrThrow<string>('AWS_ACCESS_KEY_ID')
    const secretAccessKey = this.config.getOrThrow<string>(
      'AWS_SECRET_ACCESS_KEY',
    )
    this.bucketName = this.config.getOrThrow<string>('S3_BUCKET_NAME')

    // Normalize folder prefix: remove leading/trailing slashes, default to 'slack-clone'
    const rawPrefix =
      this.config.get<string>('S3_FOLDER_PREFIX') ?? 'slack-clone'
    this.folderPrefix = rawPrefix.replace(/^\/+|\/+$/g, '') || 'slack-clone'

    this.s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    })

    this.logger.log(
      `S3Service initialized: bucket=${this.bucketName}, region=${region}, prefix=${this.folderPrefix}`,
    )
  }

  /**
   * Generate presigned PUT URL cho client upload trực tiếp lên S3
   *
   * @param fileName - Tên file gốc (e.g., "report.pdf")
   * @param fileType - MIME type (e.g., "application/pdf")
   * @param fileSize - Size tính bằng bytes
   * @returns { url: string, key: string, expiresIn: number }
   */
  async generatePresignedUrl(
    fileName: string,
    fileType: string,
    fileSize: number,
  ): Promise<{ url: string; key: string; expiresIn: number }> {
    // Validation
    this.validateFile(fileName, fileSize)

    // Generate unique key: slack/files/{uuid}/{sanitized-filename}
    const uuid = randomUUID()
    const sanitizedName = this.sanitizeFileName(fileName)
    const key = `${this.folderPrefix}/files/${uuid}/${sanitizedName}`

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: fileType,
      // Metadata có thể thêm nếu cần
      Metadata: {
        originalName: fileName,
        uploadedAt: new Date().toISOString(),
      },
    })

    // Presigned URL có hiệu lực 5 phút
    const expiresIn = 300
    const url = await getSignedUrl(this.s3Client, command, { expiresIn })

    this.logger.log(`Generated presigned URL for file: ${fileName} (${key})`)

    return { url, key, expiresIn }
  }

  /**
   * Get public URL của file đã upload (dùng để lưu DB)
   * Lưu ý: bucket private → phải dùng getPresignedGetUrl() khi trả về API
   */
  getPublicUrl(key: string): string {
    return `https://${this.bucketName}.s3.${this.config.get('AWS_REGION')}.amazonaws.com/${key}`
  }

  /**
   * Generate presigned GET URL — cho phép truy cập file private trong thời gian giới hạn (mặc định 24h).
   * Dùng khi trả attachment về API (bucket S3 thường private).
   *
   * @param responseFilename - Tên file gốc để hiển thị khi download (hỗ trợ tiếng Việt/Unicode).
   *   S3 trả Content-Disposition với filename*=UTF-8'' theo RFC 5987 → Windows save dialog hiện đúng tên.
   */
  async getPresignedGetUrl(
    key: string,
    expiresIn = 86400,
    responseFilename?: string,
  ): Promise<string> {
    let responseContentDisposition: string | undefined
    if (responseFilename) {
      // RFC 5987: filename*=UTF-8''encoded — trình duyệt hiện đúng tiếng Việt
      const utf8Encoded = encodeURIComponent(responseFilename)
      const asciiFallback = this.toAsciiFilename(responseFilename)
      responseContentDisposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ...(responseContentDisposition && {
        ResponseContentDisposition: responseContentDisposition,
      }),
    })
    return getSignedUrl(this.s3Client, command, { expiresIn })
  }

  /**
   * Chuyển tên file sang ASCII-only (fallback cho HTTP header — ISO-8859-1)
   */
  private toAsciiFilename(fileName: string): string {
    const ext = fileName.match(/\.[^.]+$/)?.[0] ?? ''
    const nameWithoutExt = fileName.slice(0, fileName.length - ext.length)
    const ascii = nameWithoutExt
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '') // Bỏ dấu: ệ→e, ồ→o, ề→e
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100)
    return (ascii || 'file') + ext
  }

  /**
   * Kiểm tra URL có phải S3 URL của bucket này không, và trích xuất key
   */
  parseS3KeyFromUrl(url: string): string | null {
    const region = this.config.get<string>('AWS_REGION') ?? ''
    const escapedBucket = this.bucketName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedRegion = (region ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `^https://${escapedBucket}\\.s3\\.${escapedRegion}\\.amazonaws\\.com/(.+)$`,
    )
    const match = url.match(pattern)
    return match ? decodeURIComponent(match[1]) : null
  }

  /**
   * Validate file extension và size
   */
  private validateFile(fileName: string, fileSize: number): void {
    // Check size
    if (fileSize > this.MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File quá lớn. Max: ${this.MAX_FILE_SIZE / 1024 / 1024}MB`,
      )
    }
  }

  /**
   * Sanitize file name: loại bỏ ký tự đặc biệt, giữ extension
   */
  private sanitizeFileName(fileName: string): string {
    const ext = fileName.match(/\.[^.]+$/)?.[0] ?? ''
    const nameWithoutExt = fileName.slice(0, fileName.length - ext.length)
    const sanitized = nameWithoutExt
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 100)
    return `${sanitized}${ext}`
  }
}
