import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  UpsertMessageDraftSchema,
  type UpsertMessageDraftDto,
} from './dto/message-draft.dto'
import { MessageDraftService } from './message-draft.service'

@Controller('workspaces/:workspaceId/message-drafts')
@UseGuards(JwtAuthGuard)
export class MessageDraftController {
  constructor(private readonly messageDraftService: MessageDraftService) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string, @Req() req: Request) {
    const { id: userId } = req.user as { id: string }
    return this.messageDraftService.list(workspaceId, userId)
  }

  @Get('current')
  findCurrent(
    @Param('workspaceId') workspaceId: string,
    @Query('contextKey') contextKey: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    if (!contextKey) {
      return { draft: null }
    }
    const decoded = decodeURIComponent(contextKey)
    return this.messageDraftService
      .findByContext(workspaceId, userId, decoded)
      .then((draft) => ({ draft }))
  }

  @Put()
  upsert(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpsertMessageDraftSchema))
    dto: UpsertMessageDraftDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.messageDraftService.upsert(
      workspaceId,
      userId,
      dto.contextKey,
      dto.content,
      socketId,
    )
  }

  @Delete()
  remove(
    @Param('workspaceId') workspaceId: string,
    @Query('contextKey') contextKey: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    if (!contextKey) {
      return { ok: true as const, deleted: false }
    }
    const decoded = decodeURIComponent(contextKey)
    return this.messageDraftService.remove(
      workspaceId,
      userId,
      decoded,
      socketId,
    )
  }
}
