import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler'
import { APP_GUARD } from '@nestjs/core'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { DatabaseModule } from './database/database.module'
import { RedisModule } from './redis/redis.module'
import { MailModule } from './mail/mail.module'
import { AuthModule } from './auth/auth.module'
import { WorkspaceModule } from './workspace/workspace.module'
import { ChannelModule } from './channel/channel.module'
import { MessageModule } from './message/message.module'
import { ChatModule } from './chat/chat.module'
import { UploadModule } from './upload/upload.module'
import { AttachmentModule } from './attachment/attachment.module'
import { FolderModule } from './folder/folder.module'
import { UserProfileModule } from './user-profile/user-profile.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
    /**
     * ThrottlerModule — Rate Limiting cho toàn bộ REST API
     *
     * Cấu hình 2 "buckets":
     *   - global: 60 requests / 60s per IP (1 req/s average)
     *     → Chống abuse chung, đủ thoải mái cho normal usage
     *
     *   - message: override riêng cho message endpoint qua @Throttle()
     *     → 10 messages / 10s per user (chống spam chat)
     *
     * Storage: in-memory (default).
     * Upgrade: dùng ThrottlerStorageRedisService từ @nestjs-modules/ioredis
     * nếu scale lên nhiều replicas (cần shared state).
     */
    ThrottlerModule.forRoot([
      {
        name: 'global',
        ttl: 60000,  // 60 giây (tính bằng ms)
        limit: 60,   // 60 requests / 60s
      },
      {
        name: 'message',
        ttl: 10000,  // 10 giây
        limit: 10,   // 10 messages / 10s
      },
    ]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    /**
     * APP_GUARD với ThrottlerGuard → apply rate limiting globally
     * cho mọi endpoint trừ những endpoint có @SkipThrottle()
     */
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
