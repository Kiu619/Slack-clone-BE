import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { RecentVisitSchema, type RecentVisitDto } from './dto/recent-visit.dto'
import { RecentService } from './recent.service'

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class RecentController {
  constructor(private readonly recentService: RecentService) {}

  @Get(':workspaceId/recents')
  async listRecents(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.recentService.listRecents(workspaceId, userId)
  }

  @Post(':workspaceId/recents/visit')
  @HttpCode(HttpStatus.OK)
  async recordVisit(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(RecentVisitSchema)) dto: RecentVisitDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.recentService.recordVisit(workspaceId, userId, dto, socketId)
  }
}
