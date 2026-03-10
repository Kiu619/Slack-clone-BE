import { Global, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export const DRIZZLE = Symbol('DRIZZLE')

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const connectionString = config.getOrThrow<string>('DATABASE_URL')
        /**
         * Connection Pool config cho postgres.js:
         *   max: 20 — tăng từ default 10 lên 20
         *     → Với 50-100 concurrent users, 10 connections dễ bị bottleneck
         *     → 20 cho phép nhiều queries song song hơn
         *   idle_timeout: 30s — đóng connection idle sau 30s
         *     → Tiết kiệm memory trên Neon free tier
         *   connect_timeout: 10s — timeout nếu không lấy được connection
         *     → Fail fast thay vì hang vô thời hạn
         *
         * Lưu ý: Neon serverless có giới hạn connections tùy plan.
         * Free tier: 100 connections max. max=20 là an toàn.
         */
        const client = postgres(connectionString, {
          ssl: 'require',
          max: 20,
          idle_timeout: 30,
          connect_timeout: 10,
        })
        return drizzle(client, { schema })
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
