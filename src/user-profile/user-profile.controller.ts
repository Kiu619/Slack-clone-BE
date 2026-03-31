import {
  Controller,
  Get,
  Patch,
  Body,
  Req,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import type { Request } from 'express'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe'
import { UserProfileService } from './user-profile.service'
import {
  UpdateProfileSchema,
  type UpdateProfileDto,
} from './dto/update-profile.dto'
import {
  UpdateContactSchema,
  type UpdateContactDto,
} from './dto/update-contact.dto'
import {
  UpdateAboutMeSchema,
  type UpdateAboutMeDto,
} from './dto/update-about-me.dto'
import { z } from 'zod'

const WorkspaceIdSchema = z.string().uuid('workspaceId must be a valid UUID')

@Controller('user-profile')
@UseGuards(JwtAuthGuard)
export class UserProfileController {
  constructor(private readonly userProfileService: UserProfileService) { }

  private parseWorkspaceId(raw: string | undefined): string {
    if (!raw?.trim()) {
      throw new BadRequestException('Query workspaceId is required')
    }
    const r = WorkspaceIdSchema.safeParse(raw)
    if (!r.success) {
      throw new BadRequestException(r.error.flatten().formErrors.join(', '))
    }
    return r.data
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  getMe(@Req() req: Request, @Query('workspaceId') workspaceIdRaw?: string) {
    const { id: userId } = req.user as { id: string }
    const workspaceId = this.parseWorkspaceId(workspaceIdRaw)
    return this.userProfileService.getProfile(userId, workspaceId)
  }

  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  updateProfile(
    @Req() req: Request,
    @Query('workspaceId') workspaceIdRaw: string | undefined,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto,
  ) {
    const { id: userId } = req.user as { id: string }
    const workspaceId = this.parseWorkspaceId(workspaceIdRaw)
    return this.userProfileService.updateProfile(userId, workspaceId, dto)
  }

  @Patch('contact')
  @HttpCode(HttpStatus.OK)
  updateContact(
    @Req() req: Request,
    @Query('workspaceId') workspaceIdRaw: string | undefined,
    @Body(new ZodValidationPipe(UpdateContactSchema)) dto: UpdateContactDto,
  ) {
    const { id: userId } = req.user as { id: string }
    const workspaceId = this.parseWorkspaceId(workspaceIdRaw)
    return this.userProfileService.updateContact(userId, workspaceId, dto)
  }

  @Patch('about-me')
  @HttpCode(HttpStatus.OK)
  updateAboutMe(
    @Req() req: Request,
    @Query('workspaceId') workspaceIdRaw: string | undefined,
    @Body(new ZodValidationPipe(UpdateAboutMeSchema)) dto: UpdateAboutMeDto,
  ) {
    const { id: userId } = req.user as { id: string }
    const workspaceId = this.parseWorkspaceId(workspaceIdRaw)
    return this.userProfileService.updateAboutMe(userId, workspaceId, dto)
  }
}
