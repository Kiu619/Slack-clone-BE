/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { PipeTransform, BadRequestException } from '@nestjs/common'
import { ZodSchema } from 'zod'

export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value)
    if (!result.success) {
      const issues = result.error.issues ?? (result.error as any).errors ?? []
      const messages = issues
        .map((e: { message: string }) => e.message)
        .join(', ')
      throw new BadRequestException(messages)
    }
    return result.data
  }
}
