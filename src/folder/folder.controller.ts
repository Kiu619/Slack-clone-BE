import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { SkipThrottle } from '@nestjs/throttler'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { FolderService } from './folder.service'
import {
  AddAttachmentToFolderSchema,
  CreateFolderSchema,
  RenameFolderSchema,
  UploadFileToFolderSchema,
  type AddAttachmentToFolderDto,
  type CreateFolderDto,
  type RenameFolderDto,
  type UploadFileToFolderDto,
} from './dto/folder.dto'
import { ChatBroadcastService } from '../chat/chat-broadcast.service'

@Controller()
@UseGuards(JwtAuthGuard)
export class FolderController {
  constructor(
    private readonly folderService: FolderService,
    private readonly broadcastService: ChatBroadcastService,
  ) {}

  @Get('channels/:channelId/folders')
  @SkipThrottle({ message: true })
  listFolders(
    @Param('channelId') channelId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.folderService.listFolders(channelId, userId)
  }

  @Post('channels/:channelId/folders')
  @HttpCode(HttpStatus.CREATED)
  createFolder(
    @Param('channelId') channelId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(CreateFolderSchema)) dto: CreateFolderDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.folderService.createFolder(channelId, userId, dto.name)
  }

  @Patch('channels/:channelId/folders/:folderId')
  renameFolder(
    @Param('channelId') channelId: string,
    @Param('folderId') folderId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(RenameFolderSchema)) dto: RenameFolderDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.folderService.renameFolder(
      channelId,
      folderId,
      userId,
      dto.name,
    )
  }

  @Delete('channels/:channelId/folders/:folderId')
  @HttpCode(HttpStatus.OK)
  deleteFolder(
    @Param('channelId') channelId: string,
    @Param('folderId') folderId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.folderService.deleteFolder(channelId, folderId, userId)
  }

  @Get('channels/:channelId/folders/:folderId/attachments')
  @SkipThrottle({ message: true })
  listFolderAttachments(
    @Param('channelId') channelId: string,
    @Param('folderId') folderId: string,
    @Query('cursor') cursor: string | undefined,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.folderService.listFolderAttachments(
      channelId,
      folderId,
      userId,
      cursor,
    )
  }

  /**
   * POST sau khi client upload file lên S3/Cloudinary (cùng flow useFileUpload).
   */
  @Post('channels/:channelId/folders/:folderId/files')
  @HttpCode(HttpStatus.CREATED)
  async uploadFileToFolder(
    @Param('channelId') channelId: string,
    @Param('folderId') folderId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(UploadFileToFolderSchema))
    dto: UploadFileToFolderDto,
    @Headers('x-socket-id') socketId?: string,
  ) {
    const { id: userId } = req.user as { id: string }
    const { messageId, attachment } =
      await this.folderService.uploadFileToFolder(
        channelId,
        folderId,
        userId,
        dto,
      )
    void this.broadcastService.broadcastAttachmentAdded(
      channelId,
      { messageId, attachment },
      socketId,
    )
    return attachment
  }

  @Post('channels/:channelId/folders/:folderId/attachments')
  @HttpCode(HttpStatus.CREATED)
  addAttachment(
    @Param('channelId') channelId: string,
    @Param('folderId') folderId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(AddAttachmentToFolderSchema))
    dto: AddAttachmentToFolderDto,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.folderService.addAttachmentToFolder(
      channelId,
      folderId,
      userId,
      dto.attachmentId,
    )
  }

  @Delete('channels/:channelId/folders/:folderId/attachments/:attachmentId')
  @HttpCode(HttpStatus.OK)
  removeAttachment(
    @Param('channelId') channelId: string,
    @Param('folderId') folderId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: Request,
  ) {
    const { id: userId } = req.user as { id: string }
    return this.folderService.removeAttachmentFromFolder(
      channelId,
      folderId,
      userId,
      attachmentId,
    )
  }
}
