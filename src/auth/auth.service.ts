import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import type { Response } from 'express'
import { randomBytes } from 'crypto'
import { eq, and } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { users, accounts } from '../database/schema'
import { RedisService } from '../redis/redis.service'
import { MailService } from '../mail/mail.service'

const MAGIC_TOKEN_TTL = 60 * 15

const ACCESS_TOKEN_COOKIE_TTL = 31 * 24 * 60 * 60 * 1000
const REFRESH_TOKEN_COOKIE_TTL = 100 * 24 * 60 * 60 * 1000

export interface OAuthUserData {
  provider: string
  providerAccountId: string
  email: string
  name?: string
  avatar?: string
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async findOrCreateOAuthUser(data: OAuthUserData) {
    const { provider, providerAccountId, email, name, avatar } = data

    // Check if account already exists
    const [existingAccount] = await this.db
      .select({ user: users })
      .from(accounts)
      .innerJoin(users, eq(accounts.userId, users.id))
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.providerAccountId, providerAccountId),
        ),
      )
      .limit(1)

    if (existingAccount) return existingAccount.user

    // Find or create user by email
    let [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (!user) {
      ;[user] = await this.db
        .insert(users)
        .values({ email, name: name ?? null, avatar: avatar ?? null })
        .returning()
    }

    // Link the OAuth account
    await this.db
      .insert(accounts)
      .values({ userId: user.id, provider, providerAccountId })
      .onConflictDoNothing()

    return user
  }

  async sendMagicLink(email: string): Promise<void> {
    const token = randomBytes(32).toString('hex')
    await this.redis.set(`magic:${token}`, email, MAGIC_TOKEN_TTL)

    const frontendUrl = this.config.get<string>('FRONTEND_URL')
    const magicUrl = `${frontendUrl}/auth/callback?token=${token}&type=magic`
    await this.mail.sendMagicLink(email, magicUrl)
  }

  async verifyMagicLink(token: string) {
    const email = await this.redis.get(`magic:${token}`)
    if (!email) {
      throw new UnauthorizedException('Magic link is invalid or has expired')
    }
    await this.redis.del(`magic:${token}`)

    let [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (!user) {
      ;[user] = await this.db.insert(users).values({ email }).returning()
    }

    await this.db
      .insert(accounts)
      .values({ userId: user.id, provider: 'email', providerAccountId: email })
      .onConflictDoNothing()

    return user
  }

  /**
   * generateTokens — tạo JWT access + refresh token
   *
   * Access token payload chứa { sub, email, name, avatar } để:
   *   - ChatGateway đọc userName mà không cần query DB khi WS connect
   *   - MessageController truyền userInfo đầy đủ (kể cả avatar) vào createMessage
   *
   * Trade-off: avatar URL trong token sẽ stale nếu user thay avatar.
   * Acceptable vì: token expire sau 30d, và avatar change rất ít khi xảy ra.
   * Nếu cần real-time avatar update → bỏ avatar ra khỏi JWT, query DB mỗi lần.
   */
  generateTokens(
    userId: string,
    email: string,
    name?: string | null,
    avatar?: string | null,
    isAway?: boolean,
  ) {
    const accessToken = this.jwt.sign(
      {
        sub: userId,
        email,
        name: name ?? null,
        avatar: avatar ?? null,
        isAway,
      },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_EXPIRATION') ?? '30d',
      },
    )

    const refreshToken = this.jwt.sign(
      { sub: userId, email },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get('JWT_REFRESH_EXPIRATION') ?? '90d',
      },
    )

    return { accessToken, refreshToken }
  }

  setTokenCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
  ): void {
    const isProd = this.config.get<string>('NODE_ENV') === 'production'

    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: ACCESS_TOKEN_COOKIE_TTL,
    })

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: REFRESH_TOKEN_COOKIE_TTL,
      path: '/auth/refresh',
    })
  }

  clearTokenCookies(res: Response): void {
    res.clearCookie('access_token')
    res.clearCookie('refresh_token', { path: '/auth/refresh' })
  }
}
