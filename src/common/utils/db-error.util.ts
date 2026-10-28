/**
 * PostgreSQL error code constants
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PgErrorCodes = {
  /** unique_violation - Duplicate key value violates unique constraint */
  UNIQUE_VIOLATION: '23505',
  /** foreign_key_violation - Referenced record not found */
  FOREIGN_KEY_VIOLATION: '23503',
  /** check_violation - Check constraint violation */
  CHECK_VIOLATION: '23514',
  /** not_null_violation - Column cannot be null */
  NOT_NULL_VIOLATION: '23502',
  /** exclusion_violation - Exclusion constraint violation */
  EXCLUSION_VIOLATION: '23P01',
} as const

export type PgErrorCode = (typeof PgErrorCodes)[keyof typeof PgErrorCodes]

/**
 * Represents a raw PostgreSQL error from driver
 */
interface PgError {
  code?: string
  cause?: {
    code?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Check if an error is a PostgreSQL unique violation (duplicate key)
 * Handles multiple error structures from different drivers
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error) return false

  // Extract code from various structures
  let code: string | undefined

  // Case 1: Direct property on object
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>
    code = obj.code as string | undefined

    // Case 2: Drizzle wraps in cause
    if (!code && obj.cause) {
      code = (obj.cause as Record<string, unknown>).code as string | undefined
    }

    // Case 3: Nested cause (some drivers)
    if (!code && obj.cause && typeof obj.cause === 'object') {
      const cause = obj.cause as Record<string, unknown>
      if (cause.cause) {
        code = (cause.cause as Record<string, unknown>).code as string | undefined
      }
    }
  }

  // Case 4: Error with code property
  if (error instanceof Error) {
    code ??= (error as unknown as Record<string, unknown>).code as string | undefined
  }

  return code === PgErrorCodes.UNIQUE_VIOLATION
}

/**
 * Check if an error is a PostgreSQL foreign key violation
 */
export function isForeignKeyViolation(error: unknown): boolean {
  try {
    const pgError = error as PgError
    return (
      pgError.code === PgErrorCodes.FOREIGN_KEY_VIOLATION ||
      pgError.cause?.code === PgErrorCodes.FOREIGN_KEY_VIOLATION
    )
  } catch {
    return false
  }
}

/**
 * Check if an error is any known PostgreSQL constraint violation
 */
export function isConstraintViolation(error: unknown): boolean {
  return isUniqueViolation(error) || isForeignKeyViolation(error)
}
