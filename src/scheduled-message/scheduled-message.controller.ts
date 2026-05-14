import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import {
  CreateScheduledMessageSchema,
  ListScheduledQuerySchema,
  UpdateScheduledMessageSchema,
  type CreateScheduledMessageDto,
  type UpdateScheduledMessageDto,
} from './dto/scheduled-message.dto'
import { ScheduledMessageService } from './scheduled-message.service'

@Controller('workspaces/:workspaceId/scheduled-messages')
@UseGuards(JwtAuthGuard)
export class ScheduledMessageController {
  constructor(private readonly scheduledMessageService: ScheduledMessageService) {}

  @Get()
  list(
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(ListScheduledQuerySchema))
    query: { status?: 'pending' | 'cancelled' | 'all' },
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.scheduledMessageService.list(
      workspaceId,
      userId,
      query.status,
    )
  }

  @Post()
  create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateScheduledMessageSchema))
    dto: CreateScheduledMessageDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.scheduledMessageService.create(
      workspaceId,
      userId,
      dto,
      socketId,
    )
  }

  @Patch(':id')
  reschedule(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateScheduledMessageSchema))
    dto: UpdateScheduledMessageDto,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.scheduledMessageService.reschedule(
      workspaceId,
      userId,
      id,
      dto,
      socketId,
    )
  }

  @Delete(':id')
  cancel(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.scheduledMessageService.cancel(
      workspaceId,
      userId,
      id,
      socketId,
    )
  }
}
