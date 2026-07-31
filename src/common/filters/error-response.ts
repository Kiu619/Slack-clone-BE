/**
 * Standardized error response format for all API errors.
 * Provides machine-readable error codes for frontend error handling.
 */

export interface ErrorResponse {
  statusCode: number
  code: string
  message: string
  timestamp: string
  path?: string
}

export type ErrorCode =
  | 'VALIDATION_ERROR'   // Zod/class-validator validation failed
  | 'NOT_FOUND'          // Resource not found (404)
  | 'FORBIDDEN'          // Access denied (403)
  | 'UNAUTHORIZED'       // Not authenticated (401)
  | 'BAD_REQUEST'        // General bad request (400)
  | 'INTERNAL_ERROR'     // Unexpected server error (500)
  | 'THIRD_PARTY_ERROR'  // External service (Redis, S3, Cloudinary, etc.) failed
  | 'CONFLICT'           // Resource conflict (409)
  | 'TOO_MANY_REQUESTS'  // Rate limited (429)

/**
 * Maps HTTP status codes to error codes
 */
export const STATUS_TO_ERROR_CODE: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  502: 'THIRD_PARTY_ERROR',
  503: 'THIRD_PARTY_ERROR',
}

/**
 * Maps error codes to user-friendly messages
 * These are displayed to users via frontend toast
 */
export const ERROR_CODE_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Please check your input and try again',
  NOT_FOUND: 'The requested resource was not found',
  FORBIDDEN: 'You do not have permission to perform this action',
  UNAUTHORIZED: 'Please log in to continue',
  BAD_REQUEST: 'Invalid request',
  INTERNAL_ERROR: 'Something went wrong on our end',
  THIRD_PARTY_ERROR: 'External service temporarily unavailable',
  CONFLICT: 'Resource conflict detected',
  TOO_MANY_REQUESTS: 'Too many requests. Please try again later',
}
