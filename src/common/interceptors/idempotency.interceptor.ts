import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common'
import { Observable, of } from 'rxjs'
import { tap } from 'rxjs/operators'
import { IdempotencyService } from '../services/idempotency.service'

export const IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key'
export const IDEMPOTENCY_TTL_KEY = 'idempotencyTtl'

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotencyService: IdempotencyService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest()
    const idempotencyKey = request.headers[IDEMPOTENCY_KEY_HEADER]

    // If no idempotency key, proceed normally
    if (!idempotencyKey) {
      return next.handle()
    }

    // Check if we have a cached response
    const existingRecord = await this.idempotencyService.getRecord(idempotencyKey)

    if (existingRecord?.status === 'completed' && existingRecord.response) {
      // Return cached response
      return of(existingRecord.response)
    }

    // Try to acquire lock
    const lockTtl = (request[IDEMPOTENCY_TTL_KEY] as number) || 300
    const lockAcquired = await this.idempotencyService.acquireLock(
      idempotencyKey,
      lockTtl,
    )

    if (!lockAcquired) {
      // Another request is processing with the same key
      // Re-check for cached response
      const retryRecord = await this.idempotencyService.getRecord(idempotencyKey)
      if (retryRecord?.status === 'completed' && retryRecord.response) {
        return of(retryRecord.response)
      }

      // Still processing, return 409 Conflict
      return of({
        statusCode: 409,
        message: 'Request with this idempotency key is already being processed',
        error: 'Conflict',
      })
    }

    // Execute handler and store response
    return next.handle().pipe(
      tap(async (response) => {
        await this.idempotencyService.storeResponse(idempotencyKey, response, lockTtl)
      }),
    )
  }
}
