import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {
  handleRequest(err: any, user: any, info: any) {
    if (err instanceof ServiceUnavailableException) throw err
    if (err || !user) {
      const message =
        info?.name === 'TokenExpiredError'
          ? 'Refresh token has expired'
          : 'Invalid refresh token'
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'SESSION_EXPIRED',
        message,
      })
    }
    return user
  }
}
