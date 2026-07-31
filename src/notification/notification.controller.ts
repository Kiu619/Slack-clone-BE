import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Request,
  Patch,
  Body,
  Headers,
  Delete,
} from '@nestjs/common'
import { NotificationService } from './notification.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import {
  UpdateGlobalSettingsSchema,
  UpdateChannelOverrideSchema,
} from './dto/update-settings.dto'
import type {
  UpdateGlobalSettingsDto,
  UpdateChannelOverrideDto,
} from './dto/update-settings.dto'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  async getNotifications(
    @Request() req,
    @Query('workspaceId') workspaceId: string,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.notificationService.getNotifications(
      req.user.id,
      workspaceId,
      limit ? Number(limit) : 20,
      cursor,
    )
  }

  @Get('unread-count')
  async getUnreadCount(
    @Request() req,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.notificationService.getUnreadCount(req.user.id, workspaceId)
  }

  @Patch(':id/read')
  async markAsRead(@Request() req, @Param('id') id: string) {
    return this.notificationService.markAsRead(id, req.user.id)
  }

  @Delete(':id')
  async clearNotification(@Request() req, @Param('id') id: string) {
    return this.notificationService.clearNotification(id, req.user.id)
  }

  @Post('read-all')
  async markAllAsRead(
    @Request() req,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.notificationService.markAllAsRead(req.user.id, workspaceId)
  }

  // ─── Settings Endpoints ───

  @Patch('settings/global')
  async updateGlobalSettings(
    @Request() req,
    @Query('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateGlobalSettingsSchema))
    dto: UpdateGlobalSettingsDto,
  ) {
    return this.notificationService.updateGlobalSettings(
      req.user.id,
      workspaceId,
      dto,
    )
  }

  @Patch('settings/override')
  async updateChannelOverride(
    @Request() req,
    @Query('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateChannelOverrideSchema))
    dto: UpdateChannelOverrideDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    return this.notificationService.updateChannelOverride(
      req.user.id,
      workspaceId,
      dto,
      socketId,
    )
  }

  @Get('settings/override')
  async getChannelOverride(
    @Request() req,
    @Query('workspaceId') workspaceId: string,
    @Query('channelId') channelId?: string,
    @Query('conversationId') conversationId?: string,
  ) {
    return this.notificationService.getEffectiveNotificationSetting(
      req.user.id,
      workspaceId,
      channelId,
      conversationId,
    )
  }

  // ─── Unread Counts Endpoints ───

  @Get('workspace-unread-counts')
  async getWorkspaceUnreadCounts(
    @Request() req,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.notificationService.getWorkspaceUnreadCounts(
      req.user.id,
      workspaceId,
    )
  }

  @Post('channels/:id/mark-as-read')
  async markChannelAsRead(@Request() req, @Param('id') id: string) {
    return this.notificationService.markChannelAsRead(req.user.id, id)
  }

  @Post('conversations/:id/mark-as-read')
  async markConversationAsRead(@Request() req, @Param('id') id: string) {
    return this.notificationService.markConversationAsRead(req.user.id, id)
  }

  @Get('mentions')
  async getMentions(
    @Request() req,
    @Query('workspaceId') workspaceId: string,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.notificationService.getMentions(
      req.user.id,
      workspaceId,
      limit ? Number(limit) : 20,
      cursor,
    )
  }
}
