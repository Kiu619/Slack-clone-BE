import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { WorkspaceEmojisService } from './workspace-emojis.service'
import {
  CreateWorkspaceCustomEmojiAliasSchema,
  CreateWorkspaceCustomEmojiSchema,
  WorkspaceCustomEmojisQuerySchema,
  type CreateWorkspaceCustomEmojiAliasDto,
  UpdateWorkspaceEmojiOneClickSchema,
  type CreateWorkspaceCustomEmojiDto,
  type WorkspaceCustomEmojisQueryDto,
  type UpdateWorkspaceEmojiOneClickDto,
} from './dto/workspace-emojis.dto'

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspaceEmojisController {
  constructor(
    private readonly workspaceEmojisService: WorkspaceEmojisService,
  ) {}

  @Post(':workspaceId/custom-emojis')
  createCustomEmoji(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateWorkspaceCustomEmojiSchema))
    dto: CreateWorkspaceCustomEmojiDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceEmojisService.createCustomEmoji(
      workspaceId,
      userId,
      dto,
      socketId,
    )
  }

  @Post(':workspaceId/custom-emojis/aliases')
  createCustomEmojiAlias(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateWorkspaceCustomEmojiAliasSchema))
    dto: CreateWorkspaceCustomEmojiAliasDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceEmojisService.createCustomEmojiAlias(
      workspaceId,
      userId,
      dto,
      socketId,
    )
  }

  @Get(':workspaceId/custom-emojis')
  getCustomEmojis(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Query(new ZodValidationPipe(WorkspaceCustomEmojisQuerySchema))
    query: WorkspaceCustomEmojisQueryDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceEmojisService.getCustomEmojisPage(
      workspaceId,
      userId,
      query,
    )
  }

  @Patch(':workspaceId/custom-emojis/one-click')
  updateOneClickReactions(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateWorkspaceEmojiOneClickSchema))
    dto: UpdateWorkspaceEmojiOneClickDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceEmojisService.updateOneClickReactions(
      workspaceId,
      userId,
      dto,
      socketId,
    )
  }

  @Delete(':workspaceId/custom-emojis/:emojiId')
  deleteCustomEmoji(
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('emojiId') emojiId: string,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.workspaceEmojisService.deleteCustomEmoji(
      workspaceId,
      userId,
      emojiId,
      socketId,
    )
  }
}
