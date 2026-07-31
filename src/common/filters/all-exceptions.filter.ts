import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { Request, Response } from 'express'
import { ZodError, ZodIssue } from 'zod'
import {
  ErrorResponse,
  ErrorCode,
  STATUS_TO_ERROR_CODE,
  ERROR_CODE_MESSAGES,
} from './error-response.js'

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()
    const request = ctx.getRequest<Request>()

    const { statusCode, errorResponse, logMessage } = this.mapException(
      exception,
      request,
    )

    // Log full error details for debugging (internal only)
    this.logger.error(logMessage)

    response.status(statusCode).json(errorResponse)
  }

  private mapException(
    exception: unknown,
    request: Request,
  ): {
    statusCode: number
    errorResponse: ErrorResponse
    logMessage: string
  } {
    // Handle NestJS HttpException
    if (exception instanceof HttpException) {
      return this.handleHttpException(exception, request)
    }

    // Handle Zod validation errors (from ZodValidationPipe)
    if (exception instanceof ZodError) {
      return this.handleZodError(exception, request)
    }

    // Handle unknown errors
    return this.handleUnknownError(exception, request)
  }

  private handleHttpException(
    exception: HttpException,
    request: Request,
  ): { statusCode: number; errorResponse: ErrorResponse; logMessage: string } {
    const statusCode = exception.getStatus()
    const exceptionResponse = exception.getResponse()

    // Already formatted (from AllExceptionsFilter itself or explicit format)
    if (typeof exceptionResponse === 'object' && 'code' in exceptionResponse) {
      const data = exceptionResponse as ErrorResponse
      return {
        statusCode,
        errorResponse: {
          ...data,
          timestamp: new Date().toISOString(),
          path: request.url,
        },
        logMessage: this.formatLogMessage(exception, request, statusCode),
      }
    }

    // NestJS default format or string message
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : ((
            exceptionResponse as { message?: string | string[] }
          ).message?.toString() ?? 'An error occurred')

    const code = STATUS_TO_ERROR_CODE[statusCode] ?? 'INTERNAL_ERROR'

    return {
      statusCode,
      errorResponse: {
        statusCode,
        code,
        message,
        timestamp: new Date().toISOString(),
        path: request.url,
      },
      logMessage: this.formatLogMessage(exception, request, statusCode),
    }
  }

  private handleZodError(
    exception: ZodError,
    request: Request,
  ): { statusCode: number; errorResponse: ErrorResponse; logMessage: string } {
    const statusCode = HttpStatus.UNPROCESSABLE_ENTITY
    const issues: ZodIssue[] = exception.issues
    const message = issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ')

    return {
      statusCode,
      errorResponse: {
        statusCode,
        code: 'VALIDATION_ERROR',
        message,
        timestamp: new Date().toISOString(),
        path: request.url,
      },
      logMessage: `ZodError: ${issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')} | Path: ${request.url}`,
    }
  }

  private handleUnknownError(
    exception: unknown,
    request: Request,
  ): { statusCode: number; errorResponse: ErrorResponse; logMessage: string } {
    const statusCode = HttpStatus.INTERNAL_SERVER_ERROR

    // Detect common third-party errors
    let code: ErrorCode = 'INTERNAL_ERROR'
    let userMessage = ERROR_CODE_MESSAGES[code]

    if (exception instanceof Error) {
      const errorName = exception.constructor.name.toLowerCase()
      const errorMessage = exception.message.toLowerCase()

      if (
        errorName.includes('redis') ||
        errorName.includes('prisma') ||
        errorName.includes('drizzle') ||
        errorMessage.includes('database') ||
        errorMessage.includes('prisma') ||
        errorMessage.includes('drizzle')
      ) {
        console.log('DB_ERROR')
      } else if (
        errorName.includes('s3') ||
        errorName.includes('cloudinary') ||
        errorName.includes('aws') ||
        errorName.includes('fetch') ||
        errorMessage.includes('s3') ||
        errorMessage.includes('cloudinary')
      ) {
        code = 'THIRD_PARTY_ERROR'
        userMessage = ERROR_CODE_MESSAGES[code]
      }
    }

    return {
      statusCode,
      errorResponse: {
        statusCode,
        code,
        message: userMessage,
        timestamp: new Date().toISOString(),
        path: request.url,
      },
      logMessage: this.formatLogMessage(exception, request, statusCode),
    }
  }

  private formatLogMessage(
    exception: unknown,
    request: Request,
    statusCode: number,
  ): string {
    const timestamp = new Date().toISOString()
    const method = request.method
    const url = request.url
    const userAgent = request.headers['user-agent'] ?? 'unknown'

    let stack = ''
    if (exception instanceof Error) {
      stack = exception.stack ?? exception.message
    } else if (typeof exception === 'string') {
      stack = exception
    }

    return `[${timestamp}] ${method} ${url} | Status: ${statusCode} | UA: ${userAgent}\n${stack}`
  }
}
