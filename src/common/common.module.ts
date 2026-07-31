import { Global, Module } from '@nestjs/common'
import { IdempotencyService } from './services/idempotency.service'
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor'

@Global()
@Module({
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class CommonModule {}
