# Slack Clone — Backend (NestJS)
## Stack
- NestJS, TypeScript
- Drizzle ORM + PostgreSQL (Neon)
- Redis (Upstash) — sessions, rate limiting
- JWT (access + refresh token, HTTP-only cookies)
- Resend — transactional email
- Zod — validation
## Conventions
- Mỗi feature là 1 module: module.ts, service.ts, controller.ts, dto/
- DTOs dùng Zod schema + ZodValidationPipe
- Tất cả routes cần JwtAuthGuard trừ /auth/*
- Database queries dùng Drizzle (không dùng raw SQL trừ migration)
## Database
- Schema định nghĩa tại src/database/schema.ts
- Migration: tạo script tại scripts/migrate-*.mjs (không dùng drizzle-kit push để tránh conflict với migration history)
## File Upload & Attachments
- Storage: Cloudinary (ảnh/video, auto-optimize) + AWS S3 (file chung, PDF/doc...)
  - Lý do: Cloudinary miễn phí tier tốt cho media, S3 rẻ cho file lớn
- Flow: Presigned URL (backend generate → client upload direct)
- Validation: Zod schema + file-type + size limit
- Table: attachments (messageId, url, type, size, name)
## Security & Best Practices
- Helmet + CORS (chỉ allow frontend domain)
- Rate limiting: @nestjs/throttler + Redis backend
- Input sanitization: Zod + xss-clean (nếu render HTML)
- Password: Argon2
- JWT: RS256 nếu scale lớn (thay vì HS256)
- CSRF: Không cần cho API (JWT), nhưng cẩn thận cookie httpOnly secure sameSite=strict
- Secrets: .env + Doppler/1Password nếu deploy
- Logging: Pino hoặc NestJS logger + Sentry (error tracking)
## Performance
- Luôn luôn viết code một cách tối ưu hiệu suất nhất có thể (áp dụng các kỹ thuật tối ưu)
