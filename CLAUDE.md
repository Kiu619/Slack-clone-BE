# Slack Clone — Backend (NestJS)
## Stack
- NestJS, TypeScript
- Drizzle ORM + PostgreSQL (Neon)
- Redis (Upstash) — sessions, rate limiting
- JWT (access + refresh token, HTTP-only cookies)
- Resend — transactional email
- Zod — validation
## Conventions
- Nghiêm cấm chỉnh sửa file env (muốn gì thì phải hỏi)
- Mỗi feature là 1 module: module.ts, service.ts, controller.ts, dto/
- DTOs dùng Zod schema + ZodValidationPipe
- Business logic vào Service, HTTP logic vào Controller
- Tất cả routes cần JwtAuthGuard trừ /auth/*
- Database queries dùng Drizzle (không dùng raw SQL trừ migration)
## Database
- Schema định nghĩa tại src/database/schema.ts
- Migration: tạo script tại scripts/migrate-*.mjs (không dùng drizzle-kit push để tránh conflict với migration history)
## Real-time Communication
- WebSocket: @nestjs/websockets + Socket.io
- Scaling: Redis Pub/Sub qua @socket.io/redis-adapter (Upstash)
  - Lý do: Horizontal scaling (nhiều instance NestJS), broadcast channel messages, typing, presence
  - Không dùng Redis Streams cho chat chính (latency cao hơn, phức tạp hơn)
- Rooms: Mỗi channel là một Socket.io room (`channel:${channelId}`)
- Events chính:
  - client → server: message, typing:start, typing:stop, reaction:add, join-channel
  - server → client: message, typing, presence:update, reaction, unread:count
- Presence: Redis Set/String với TTL (user:${userId}:online)
- Typing: Redis key với TTL ngắn (channel:${channelId}:typing:${userId})
## Messages & Storage
- Lưu trữ chính: PostgreSQL (Neon) + Drizzle
- Real-time: Redis Pub/Sub broadcast (không lưu messages vào Redis)
- Cache: 
  - Recent messages per channel: Redis Sorted Set (ZADD với score = timestamp) — TTL 1-24h
  - Unread counts: Redis Hash/INCR (user:${userId}:unread:${channelId})
- Search: PostgreSQL full-text search (to_tsvector) + trigram extension nếu cần fuzzy search
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
## Testing
- Unit: Jest + @nestjs/testing cho services
- E2E: Supertest + Jest cho controllers + WebSocket testing (socket.io-client)
- Coverage goal: >80% cho business logic
- Mock: Redis mock (ioredis-mock), Drizzle mock (drizzle-orm/mocks)
