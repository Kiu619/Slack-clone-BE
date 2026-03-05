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
        const client = postgres(connectionString, { ssl: 'require' })
        return drizzle(client, { schema })
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
