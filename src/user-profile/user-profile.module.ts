import { Module } from '@nestjs/common'
import { UserProfileController } from './user-profile.controller'
import { UserProfileService } from './user-profile.service'
import { UserProfileGateway } from './user-profile.gateway'
import { UserProfileBroadcastService } from './user-profile-broadcast.service'
import { JwtModule } from '@nestjs/jwt'

@Module({
  imports: [JwtModule],
  controllers: [UserProfileController],
  providers: [UserProfileService, UserProfileGateway, UserProfileBroadcastService],
  exports: [UserProfileService, UserProfileBroadcastService],
})
export class UserProfileModule {}
