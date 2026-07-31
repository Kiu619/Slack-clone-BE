import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'
import { HuddleService } from './huddle.service'

@Controller('huddles')
export class HuddleWebhookController {
  constructor(private readonly huddleService: HuddleService) {}

  @Post('webhook')
  async receiveWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('authorization') authorization?: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException('Webhook raw body is required')
    }

    return this.huddleService.handleWebhook(
      req.rawBody.toString('utf8'),
      authorization,
    )
  }
}
