import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler'
import { APP_GUARD } from '@nestjs/core'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { DatabaseModule } from './database/database.module'
import { RedisModule } from './redis/redis.module'
import { RedisService } from './redis/redis.service'
import { MailModule } from './mail/mail.module'
import { AuthModule } from './auth/auth.module'
import { WorkspaceModule } from './workspace/workspace.module'
import { WorkspacePermissionsModule } from './workspace/workspace-permissions.module'
import { ChannelModule } from './channel/channel.module'
import { MessageModule } from './message/message.module'
import { ChatModule } from './chat/chat.module'
import { UploadModule } from './upload/upload.module'
import { AttachmentModule } from './attachment/attachment.module'
import { FolderModule } from './folder/folder.module'
import { UserProfileModule } from './user-profile/user-profile.module'
import { DirectMessageModule } from './direct-message/direct-message.module'
import { LaterModule } from './later/later.module'
import { MessageDraftModule } from './message-draft/message-draft.module'
import { ScheduledMessageModule } from './scheduled-message/scheduled-message.module'
import { RecentModule } from './recent/recent.module'
import { BullModule } from '@nestjs/bullmq'
import { NotificationModule } from './notification/notification.module'
import { WorkspaceMemberPreferencesModule } from './workspace-member-preferences/workspace-member-preferences.module'
import { HuddleModule } from './huddle/huddle.module'
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard'
import { WorkspaceMemberGuard } from './auth/guards/workspace-member.guard'
import { CommonModule } from './common/common.module'
import { HttpLoggerMiddleware } from './common/middleware/http-logger.middleware'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL')
        if (redisUrl) {
          const parsed = new URL(redisUrl)
          return {
            connection: {
              host: parsed.hostname,
              port: parseInt(parsed.port),
              username: parsed.username || undefined,
              password: parsed.password || undefined,
              tls: parsed.protocol === 'rediss:' ? {} : undefined,
              // Retry forever with exponential backoff (1s → 2s → 4s → max 30s)
              // This prevents app crash when Redis is temporarily unavailable
              maxRetriesPerRequest: null,
              retryStrategy: (times: number) => Math.min(times * 1000, 30000),
              enableOfflineQueue: true,
            },
          }
        }
        return {
          connection: {
            host: configService.get<string>('REDIS_HOST') || 'localhost',
            port: parseInt(configService.get<string>('REDIS_PORT') || '6379'),
            // Retry forever with exponential backoff
            maxRetriesPerRequest: null,
            retryStrategy: (times: number) => Math.min(times * 1000, 30000),
            enableOfflineQueue: true,
          },
        }
      },
    }),
    DatabaseModule,
    RedisModule,
    MailModule,
    AuthModule,
    UserProfileModule,
    WorkspaceModule,
    ChannelModule,
    MessageModule,
    ChatModule,
    UploadModule,
    AttachmentModule,
    FolderModule,
    NotificationModule,
    HuddleModule,
    WorkspaceMemberPreferencesModule,
    /**
     * ThrottlerModule — Rate Limiting cho toàn bộ REST API
     *
     * Storage: RedisService.getThrottlerStorage() - built-in fallback
     * - Primary: Redis với atomic Lua scripts (distributed rate limiting)
     * - Fallback: In-memory khi Redis unavailable (10 req/ttl)
     * - Auto-recovery: Tự động switch về Redis khi nó recovered
     *
     * Cấu hình 2 "buckets":
     *   - global: 60 requests / 60s per IP (1 req/s average)
     *     → Chống abuse chung, đủ thoải mái cho normal usage
     *
     *   - message: override riêng cho message endpoint qua @Throttle()
     *     → 10 messages / 10s per user (chống spam chat)
     *
     * Reference: Stripe/GitHub production patterns - fail-open với reduced limits
     */
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisService],
      useFactory: (redisService: RedisService) => ({
        throttlers: [
          {
            name: 'global',
            ttl: 60000,
            limit: 60,
          },
          {
            name: 'message',
            ttl: 10000,
            limit: 10,
          },
        ],
        storage: redisService.getThrottlerStorage(),
      }),
    }),
    DirectMessageModule,
    LaterModule,
    MessageDraftModule,
    ScheduledMessageModule,
    RecentModule,
    CommonModule,
    WorkspacePermissionsModule,
  ],

  controllers: [AppController],
  providers: [
    AppService,
    /**
     * APP_GUARD với JwtAuthGuard — chạy TRƯỚC để set request.user
     * trước khi WorkspaceMemberGuard chạy membership check.
     * Auth routes (/auth/*) được bypass qua Reflect metadata.
     */
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    /**
     * APP_GUARD với ThrottlerGuard — apply rate limiting globally
     * cho mọi endpoint trừ những endpoint có @SkipThrottle()
     */
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    /**
     * APP_GUARD với WorkspaceMemberGuard — check workspace membership globally
     * cho mọi endpoint có :workspaceId param.
     * CHẠY SAU JwtAuthGuard nên request.user đã được set.
     *
     * Routes không cần membership check phải dùng @SkipWorkspaceMemberCheck():
     * - POST /workspaces (tạo workspace mới)
     * - GET /workspaces (list user's workspaces)
     * - Routes không có workspaceId param (vd /messages/:messageId)
     */
    {
      provide: APP_GUARD,
      useClass: WorkspaceMemberGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpLoggerMiddleware).forRoutes('*')
  }
}
