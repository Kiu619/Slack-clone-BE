import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
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
import { DirectMessageModule } from './direct-message/direct-message.module';
import { LaterModule } from './later/later.module';
import { MessageDraftModule } from './message-draft/message-draft.module';
import { ScheduledMessageModule } from './scheduled-message/scheduled-message.module';
import { RecentModule } from './recent/recent.module';
import { BullModule } from '@nestjs/bullmq';
import { NotificationModule } from './notification/notification.module';


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');
        if (redisUrl) {
          const parsed = new URL(redisUrl);
          return {
            connection: {
              host: parsed.hostname,
              port: parseInt(parsed.port),
              username: parsed.username || undefined,
              password: parsed.password || undefined,
              tls: parsed.protocol === 'rediss:' ? {} : undefined,
            },
          };
        }
        return {
          connection: {
            host: configService.get<string>('REDIS_HOST') || 'localhost',
            port: parseInt(configService.get<string>('REDIS_PORT') || '6379'),
          },
        };
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
    DirectMessageModule,
    LaterModule,
    MessageDraftModule,
    ScheduledMessageModule,
    RecentModule,
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
