import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { ConfigService } from '@nestjs/config'
import type { Request, Response } from 'express'
import { randomBytes, randomUUID } from 'crypto'
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

const ONE_SECOND_MS = 1000

export interface OAuthUserData {
  provider: string
  providerAccountId: string
  email: string
  name?: string
  avatar?: string
}

export interface AccessTokenPayload {
  sub: string
  email: string
  name?: string | null
  avatar?: string | null
  jti?: string
  iat?: number
  exp?: number
}

export interface RefreshTokenPayload {
  sub: string
  email: string
  iat?: number
  exp?: number
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
   *
   * Access token mang `jti` (random UUID) để hỗ trợ blacklist khi logout.
   */
  generateTokens(
    id: string,
    email: string,
    name?: string | null,
    avatar?: string | null,
  ) {
    const accessJti = randomUUID()

    const accessToken = this.jwt.sign(
      {
        sub: id,
        email,
        name: name ?? null,
        avatar: avatar ?? null,
        jti: accessJti,
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

  /**
   * Verify access token và trả payload (kèm jti/exp) — dùng cho logout
   * để tính TTL còn lại khi blacklist.
   * Trả null nếu token invalid/expired.
   */
  decodeAccessToken(token: string): AccessTokenPayload | null {
    try {
      return this.jwt.verify<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      })
    } catch {
      return null
    }
  }

  decodeRefreshToken(token: string): RefreshTokenPayload | null {
    try {
      return this.jwt.verify<RefreshTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      })
    } catch {
      return null
    }
  }

  /**
   * Logout: blacklist cả access (theo jti) + refresh token, với TTL = thời gian
   * còn lại của token. Best-effort: nếu Redis lỗi, log warning nhưng vẫn clear cookie.
   */
  async logoutUser(
    accessToken: string | undefined,
    refreshToken: string | undefined,
  ): Promise<void> {
    const tasks: Promise<void>[] = []

    if (accessToken) {
      const payload = this.decodeAccessToken(accessToken)
      if (payload?.jti && payload.exp) {
        const ttlSec = this.remainingTtlSeconds(payload.exp)
        tasks.push(
          this.redis.addAccessTokenToBlacklist(payload.jti, ttlSec),
        )
      }
    }

    if (refreshToken) {
      const payload = this.decodeRefreshToken(refreshToken)
      if (payload?.exp) {
        const ttlSec = this.remainingTtlSeconds(payload.exp)
        tasks.push(
          this.redis.addRefreshTokenToBlacklist(refreshToken, ttlSec),
        )
      }
    }

    await Promise.all(tasks)
  }

  private remainingTtlSeconds(exp: number): number {
    const ms = exp * ONE_SECOND_MS - Date.now()
    return Math.max(0, Math.ceil(ms / ONE_SECOND_MS))
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
      path: '/',
      maxAge: ACCESS_TOKEN_COOKIE_TTL,
    })

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
      maxAge: REFRESH_TOKEN_COOKIE_TTL,
    })
  }

  clearTokenCookies(res: Response): void {
    res.clearCookie('access_token', { path: '/' })
    res.clearCookie('refresh_token', { path: '/' })
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
