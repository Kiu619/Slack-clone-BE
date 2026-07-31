import { SetMetadata } from '@nestjs/common'
import { IDEMPOTENCY_TTL_KEY } from '../../common/interceptors/idempotency.interceptor'

export const IDEMPOTENCY_KEY = 'idempotency'

/**
 * Decorator to enable idempotency for a mutation endpoint.
 * The client must send `x-idempotency-key` header with a unique key.
 *
 * @param ttlSeconds - TTL in seconds for the idempotency cache (default: 300 = 5 minutes)
 *
 * @example
 * @Post()
 * @Idempotent(300)
 * async createMessage(...) { }
 */
export const Idempotent = (ttlSeconds: number = 300) =>
  SetMetadata(IDEMPOTENCY_TTL_KEY, ttlSeconds)
