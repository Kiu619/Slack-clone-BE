import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import type { Request, Response } from 'express'
import { randomBytes } from 'crypto'
import { eq, and } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import { users, accounts } from '../database/schema'
import { RedisService } from '../redis/redis.service'
import { MailService } from '../mail/mail.service'

const MAGIC_TOKEN_TTL = 60 * 15

const ACCESS_TOKEN_COOKIE_TTL = 31 * 24 * 60 * 60 * 1000
const REFRESH_TOKEN_COOKIE_TTL = 100 * 24 * 60 * 60 * 1000

const OAUTH_REDIRECT_COOKIE_TTL_MS = 10 * 60 * 1000

const SAFE_REDIRECT_MAX_LENGTH = 2048

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
        .values({
          email,
          name: name ?? null,
          avatar: avatar ?? null,
        })
        .returning()
    }

    // Link the OAuth account
    await this.db
      .insert(accounts)
      .values({ userId: user.id, provider, providerAccountId })
      .onConflictDoNothing()

    return user
  }

  async sendMagicLink(email: string, redirect?: string): Promise<void> {
    const token = randomBytes(32).toString('hex')
    const safeRedirect = this.sanitizeRedirectPath(redirect)
    const payload = JSON.stringify({ email, redirect: safeRedirect })
    await this.redis.set(`magic:${token}`, payload, MAGIC_TOKEN_TTL)

    const frontendUrl = this.config.get<string>('FRONTEND_URL')
    const magicUrl = `${frontendUrl}/auth/callback?token=${token}&type=magic`
    await this.mail.sendMagicLink(email, magicUrl)
  }

  async verifyMagicLink(token: string) {
    const raw = await this.redis.get(`magic:${token}`)
    if (!raw) {
      throw new UnauthorizedException('Magic link is invalid or has expired')
    }
    await this.redis.del(`magic:${token}`)

    let payload: { email: string; redirect: string | null }
    try {
      const parsed = JSON.parse(raw) as { email?: string; redirect?: string | null }
      if (!parsed?.email) throw new Error('missing email')
      payload = {
        email: parsed.email,
        redirect: this.sanitizeRedirectPath(parsed.redirect ?? undefined),
      }
    } catch {
      // Backward compat: older entries stored raw email string.
      payload = { email: raw, redirect: null }
    }
    const email = payload.email

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

    return { user, redirect: payload.redirect }
  }

  /**
   * Set a short-lived HttpOnly cookie with the post-OAuth redirect URL.
   * Cookie is NOT set if redirect is null.
   */
  setOAuthRedirectCookie(res: Response, redirect: string | null): void {
    const isProd = this.config.get<string>('NODE_ENV') === 'production'
    if (redirect) {
      res.cookie('oauth_redirect', redirect, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
        maxAge: OAUTH_REDIRECT_COOKIE_TTL_MS,
      })
    } else {
      res.clearCookie('oauth_redirect')
    }
  }

  /**
   * Read the OAuth redirect from the cookie. Returns null if missing/invalid.
   * The value is sanitized before returning.
   */
  readOAuthRedirectCookie(req: Request): string | null {
    const raw = req.cookies?.['oauth_redirect'] as string | undefined
    if (!raw) return null
    return this.sanitizeRedirectPath(raw)
  }

  /** Remove the OAuth redirect cookie. */
  clearOAuthRedirectCookie(res: Response): void {
    res.clearCookie('oauth_redirect')
  }

  /**
   * Chỉ chấp nhận path tương đối cùng origin để chống open redirect.
   * Trả về `null` nếu không hợp lệ.
   */
  sanitizeRedirectPath(value: string | null | undefined): string | null {
    if (!value || typeof value !== 'string') return null
    if (value.length === 0 || value.length > SAFE_REDIRECT_MAX_LENGTH) return null
    if (!value.startsWith('/')) return null
    if (value.startsWith('//') || value.startsWith('/\\')) return null
    if (value.includes('://')) return null

    const frontendUrl = this.config.get<string>('FRONTEND_URL')
    if (!frontendUrl) return null
    try {
      const parsed = new URL(value, frontendUrl)
      if (parsed.origin !== new URL(frontendUrl).origin) return null
      return parsed.pathname + parsed.search + parsed.hash
    } catch {
      return null
    }
  }

  /**
   * Access token: sub, email, name, avatar — chỉ **default tài khoản** (bảng users).
   * Tên/avatar theo workspace lấy từ API workspace / messages, không nằm trong JWT.
   */
  generateTokens(
    id: string,
    email: string,
    name?: string | null,
    avatar?: string | null,
  ) {
    const accessToken = this.jwt.sign(
      {
        sub: id,
        email,
        name: name ?? null,
        avatar: avatar ?? null,
      },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_EXPIRATION') ?? '30d',
      },
    )

    const refreshToken = this.jwt.sign(
      { sub: id, email },
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

  /** Hồ sơ tài khoản (không gồm profile theo workspace) */
  async getAccountById(userId: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatar: users.avatar,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return user ?? null
  }
}
