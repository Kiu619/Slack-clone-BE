import { Global, Module } from '@nestjs/common'
import { RedisModule as IoRedisModule } from '@nestjs-modules/ioredis'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { RedisService } from './redis.service'

@Global()
@Module({
  imports: [
    IoRedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'single',
        url: config.get<string>('REDIS_URL'),
      }),
    }),
  ],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
