import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  CheckLaterMessagesSchema,
  SaveItemSchema,
  UpdateLaterItemSchema,
  type CheckLaterMessagesDto,
  type SaveItemDto,
  type UpdateLaterItemDto,
} from './dto/later.dto'
import { LaterService } from './later.service'

@Controller('workspaces/:workspaceId/later')
@UseGuards(JwtAuthGuard)
export class LaterController {
  constructor(private readonly laterService: LaterService) {}

  @Get()
  async getSavedItems(
    @Param('workspaceId') workspaceId: string,
    @Query('status') status: 'in_progress' | 'completed' | 'archived',
    @Query('cursor') cursor: string,
    @Query('limit') limit: string,
    @Query('hideUpcoming') hideUpcoming: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.laterService.getSavedItems(
      userId,
      workspaceId,
      status,
      cursor,
      limit ? parseInt(limit, 10) : 20,
      hideUpcoming === 'true',
    )
  }

  @Post('check-messages')
  @HttpCode(HttpStatus.OK)
  async checkSavedMessages(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CheckLaterMessagesSchema)) dto: CheckLaterMessagesDto,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.laterService.checkLaterMessagesForUser(
      userId,
      workspaceId,
      dto.messageIds,
    )
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async saveItem(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(SaveItemSchema)) dto: SaveItemDto,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.laterService.saveItem(userId, workspaceId, {
      ...dto
    })
  }

  @Patch(':id')
  async updateItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateLaterItemSchema)) dto: UpdateLaterItemDto,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.laterService.updateItem(userId, id, dto)
  }

  @Delete('completed')
  @HttpCode(HttpStatus.OK)
  async clearCompleted(
    @Param('workspaceId') workspaceId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.laterService.clearCompleted(userId, workspaceId)
  }

  @Delete('messages/:messageId')
  @HttpCode(HttpStatus.OK)
  async removeLaterByMessageId(
    @Param('workspaceId') workspaceId: string,
    @Param('messageId') messageId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.laterService.removeInProgressItemsForMessage(userId, workspaceId, messageId)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async removeItem(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.laterService.removeItem(userId, id)
  }
}

