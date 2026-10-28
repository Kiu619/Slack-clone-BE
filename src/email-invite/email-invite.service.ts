import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  GoneException,
  forwardRef,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Response } from 'express'
import { eq, and, sql, isNull, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { DRIZZLE, type DrizzleDB } from '../database/database.module'
import {
  users,
  workspaceEmailInvites,
  workspaceMembers,
  workspaces,
  channelMembers,
} from '../database/schema'
import { RedisService } from '../redis/redis.service'
import { MailService } from '../mail/mail.service'
import { AuthService } from '../auth/auth.service'
import { WorkspaceService } from '../workspace/workspace.service'

const OTP_CODE_LENGTH = 6
const OTP_TTL_SECONDS = 10 * 60 // 10 phút
const OTP_SEND_COOLDOWN_SECONDS = 30 // 30 giây
const OTP_VERIFIED_TTL_SECONDS = 5 * 60 // 5 phút (verified flag)
const OTP_ATTEMPT_TTL_SECONDS = 5 * 60 // 5 phút (counter)
const OTP_LOCK_TTL_SECONDS = 15 * 60 // 15 phút (lock sau 5 lần sai)
const OTP_MAX_ATTEMPTS = 5
const INVITE_TTL_DAYS = 7 // row workspace_email_invites tự expire sau 7 ngày

const PENDING_INVITE_COOKIE = 'pending_invite_token'
const PENDING_INVITE_COOKIE_TTL_MS = 10 * 60 * 1000 // 10 phút

export interface InvitePublicInfo {
  inviteId: string
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  email: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expiresAt: string
  invitedByName: string | null
  alreadyAccepted: boolean
}

@Injectable()
export class EmailInviteService {
  private readonly logger = new Logger(EmailInviteService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    @Inject(forwardRef(() => AuthService))
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    // forwardRef: WorkspaceModule ↔ EmailInviteModule circular
    // (xem workspace.module.ts).
    @Inject(forwardRef(() => WorkspaceService))
    private readonly workspaceService: WorkspaceService,
  ) {}

  // ─── Cookie helpers ───────────────────────────────────────────────────────

  /**
   * FE set cookie này trước khi navigate sang OAuth — BE đọc ở callback để
   * biết cần redirect về `/join/email-invite/{token}/oauth-callback`.
   */
  setPendingInviteCookie(res: Response, token: string): void {
    const isProd = this.config.get<string>('NODE_ENV') === 'production'
    res.cookie(PENDING_INVITE_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: PENDING_INVITE_COOKIE_TTL_MS,
      path: '/',
    })
  }

  readPendingInviteCookie(req: { cookies?: Record<string, string> }): string | null {
    const raw = req.cookies?.[PENDING_INVITE_COOKIE]
    return typeof raw === 'string' && raw.length > 0 ? raw : null
  }

  clearPendingInviteCookie(res: Response): void {
    res.clearCookie(PENDING_INVITE_COOKIE, { path: '/' })
  }

  // ─── Lookup public ────────────────────────────────────────────────────────

  /**
   * Tra cứu invite theo token. Trả về thông tin public (workspace name, email,
   * status). Trả null nếu token không tồn tại / bị revoke. Service caller
   * (controller) sẽ dựa vào `status` + `alreadyAccepted` để route.
   */
  async getByToken(token: string): Promise<InvitePublicInfo | null> {
    const [row] = await this.db
      .select({
        inviteId: workspaceEmailInvites.id,
        workspaceId: workspaceEmailInvites.workspaceId,
        workspaceName: workspaces.name,
        workspaceSlug: workspaces.slug,
        email: workspaceEmailInvites.email,
        status: workspaceEmailInvites.status,
        expiresAt: workspaceEmailInvites.expiresAt,
        inviterId: workspaceEmailInvites.invitedByUserId,
      })
      .from(workspaceEmailInvites)
      .innerJoin(
        workspaces,
        eq(workspaces.id, workspaceEmailInvites.workspaceId),
      )
      .where(eq(workspaceEmailInvites.token, token))
      .limit(1)

    if (!row) return null

    let inviterName: string | null = null
    if (row.inviterId) {
      const [inviter] = await this.db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, row.inviterId))
        .limit(1)
      inviterName = inviter?.name ?? inviter?.email ?? null
    }

    const expired =
      row.expiresAt != null && row.expiresAt.getTime() < Date.now()
    const status =
      row.status === 'pending' && expired ? 'expired' : row.status

    return {
      inviteId: row.inviteId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspaceSlug: row.workspaceSlug,
      email: row.email,
      status,
      expiresAt: row.expiresAt?.toISOString() ?? '',
      invitedByName: inviterName,
      alreadyAccepted: row.status === 'accepted',
    }
  }

  private async getActiveInviteByToken(token: string) {
    const info = await this.getByToken(token)
    if (!info) {
      throw new NotFoundException(
        'Invitation link is invalid or has been removed',
      )
    }
    if (info.status === 'revoked') {
      throw new GoneException(
        'This invitation has been revoked',
      )
    }
    if (info.status === 'expired') {
      throw new GoneException('This invitation has expired')
    }
    if (info.status === 'accepted') {
      throw new ConflictException('Already accepted')
    }
    return info
  }

  // ─── Create invite (admin/owner gửi email mời) ───────────────────────────

  /**
   * Tạo (hoặc trả về row pending hiện có) cho cặp (workspaceId, email).
   *
   * Idempotent: nếu đã có row `pending` cho cùng workspace + email,
   * trả về token hiện có để tránh spam email. Row `accepted` thì KHÔNG
   * reuse (user đã join rồi, gửi lại là lỗi logic — caller phải skip).
   *
   * Trả về `{ token, inviteId }` để caller build URL `/join/email-invite/{token}`.
   */
  async createInvite(params: {
    workspaceId: string
    email: string
    invitedByUserId: string
    channelId?: string
  }): Promise<{ token: string; inviteId: string }> {
    const emailLower = params.email.trim().toLowerCase()
    if (!emailLower) {
      throw new BadRequestException('Email is required')
    }

    // Match chính xác theo (workspaceId, email, channelId) — vì một email có
    // thể có N invite pending (mỗi invite cho 1 channel khác nhau khi gửi
    // multi-channel). Nếu channelId undefined → match row có channelId NULL.
    const channelFilter = params.channelId
      ? eq(workspaceEmailInvites.channelId, params.channelId)
      : isNull(workspaceEmailInvites.channelId)

    const [existing] = await this.db
      .select({
        id: workspaceEmailInvites.id,
        token: workspaceEmailInvites.token,
        status: workspaceEmailInvites.status,
        expiresAt: workspaceEmailInvites.expiresAt,
      })
      .from(workspaceEmailInvites)
      .where(
        and(
          eq(workspaceEmailInvites.workspaceId, params.workspaceId),
          eq(workspaceEmailInvites.email, emailLower),
          channelFilter,
          eq(workspaceEmailInvites.status, 'pending'),
        ),
      )
      .limit(1)

    const now = Date.now()
    if (
      existing &&
      existing.expiresAt != null &&
      existing.expiresAt.getTime() > now
    ) {
      return { token: existing.token, inviteId: existing.id }
    }

    // Tạo row mới (row expired pending sẽ bị "lu mờ" bằng row mới; row accepted
    // thì caller đã skip trước khi gọi hàm này)
    const token = randomUUID()
    const expiresAt = new Date(now + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

    const [created] = await this.db
      .insert(workspaceEmailInvites)
      .values({
        workspaceId: params.workspaceId,
        email: emailLower,
        token,
        invitedByUserId: params.invitedByUserId,
        channelId: params.channelId ?? null,
        status: 'pending',
        expiresAt,
      })
      .returning({
        id: workspaceEmailInvites.id,
        token: workspaceEmailInvites.token,
      })

    return { token: created.token, inviteId: created.id }
  }

  // ─── Send OTP ─────────────────────────────────────────────────────────────

  async sendOtp(token: string): Promise<{ sent: true; expiresInSeconds: number }> {
    const invite = await this.getActiveInviteByToken(token)

    // Rate limit: 1 request / 30s
    const cooldownKey = this.cooldownKey(invite.inviteId)
    const r = this.redis.getRedisInstance()
    if (r) {
      try {
        const set = await r.set(cooldownKey, '1', 'EX', OTP_SEND_COOLDOWN_SECONDS, 'NX')
        if (set !== 'OK') {
          throw new BadRequestException(
            `Please wait ${OTP_SEND_COOLDOWN_SECONDS}s before requesting another code`,
          )
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err
        this.logger.warn(`Redis cooldown set failed: ${err}`)
      }
    }

    const code = this.generateOtpCode()
    const hash = this.hashOtp(code, invite.inviteId)
    await this.redis.set(
      this.otpKey(invite.inviteId),
      hash,
      OTP_TTL_SECONDS,
    )

    // Reset attempts + lock cho lần gửi mới
    await this.redis.del(this.attemptsKey(invite.inviteId))
    await this.redis.del(this.lockedKey(invite.inviteId))

    try {
      await this.mail.sendOtpCode(
        invite.email,
        code,
        invite.workspaceName,
      )
    } catch (err) {
      this.logger.error(
        `Failed to send OTP to ${invite.email}: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw new BadRequestException(
        'Failed to send verification code. Please try again.',
      )
    }

    return { sent: true, expiresInSeconds: OTP_TTL_SECONDS }
  }

  // ─── Verify OTP ───────────────────────────────────────────────────────────

  async verifyOtp(
    token: string,
    code: string,
  ): Promise<{ verified: true; expiresInSeconds: number }> {
    const invite = await this.getActiveInviteByToken(token)

    if (await this.redis.get(this.lockedKey(invite.inviteId))) {
      throw new ForbiddenException(
        'Too many wrong attempts. Try again in 15 minutes.',
      )
    }

    const stored = await this.redis.get(this.otpKey(invite.inviteId))
    if (!stored) {
      throw new BadRequestException(
        'Verification code has expired. Please request a new one.',
      )
    }

    const hash = this.hashOtp(code, invite.inviteId)
    if (!this.timingSafeEqualStr(stored, hash)) {
      await this.recordFailedAttempt(invite.inviteId)
      throw new BadRequestException('Invalid code')
    }

    await this.redis.set(
      this.verifiedKey(invite.inviteId),
      '1',
      OTP_VERIFIED_TTL_SECONDS,
    )

    return { verified: true, expiresInSeconds: OTP_VERIFIED_TTL_SECONDS }
  }

  private async recordFailedAttempt(inviteId: string): Promise<void> {
    const r = this.redis.getRedisInstance()
    if (!r) return
    const attempts = await r.incr(this.attemptsKey(inviteId))
    if (attempts === 1) {
      await r.expire(this.attemptsKey(inviteId), OTP_ATTEMPT_TTL_SECONDS)
    }
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await this.redis.set(this.lockedKey(inviteId), '1', OTP_LOCK_TTL_SECONDS)
    }
  }

  // ─── Accept ───────────────────────────────────────────────────────────────

  /**
   * Hoàn tất invite:
   *   - `method='otp'`: yêu cầu Redis flag `invite-verified:{id}` tồn tại.
   *     Nếu chưa có user → tạo user mới + link account email, set JWT cookies,
   *     insert workspace_member. Mark invite accepted.
   *   - `method='oauth'`: yêu cầu `currentUser.email === invite.email`.
   *     Insert member (nếu user chưa có) + mark accepted. JWT đã có sẵn từ OAuth.
   *
   * Trả về workspace kèm cờ `alreadyMember` để FE biết có phải redirect
   * vào workspace hay không.
   */
  async acceptInvite(
    token: string,
    body: {
      name?: string
      timeZone?: string
      method: 'otp' | 'oauth'
    },
    currentUser: { id: string; email: string; name?: string | null; avatar?: string | null } | null,
    res?: Response,
  ) {
    const invite = await this.getActiveInviteByToken(token)

    if (body.method === 'otp') {
      const verified = await this.redis.get(this.verifiedKey(invite.inviteId))
      if (!verified) {
        throw new ForbiddenException(
          'Verification expired or missing. Please enter the code again.',
        )
      }
    }

    let user = currentUser
    if (!user) {
      // Nhánh OTP: tạo user mới (auto) — currentUser null là khi user chưa login
      user = await this.findOrCreateUserByEmail(invite.email, body.name)
    } else {
      // Đã có currentUser (cả OTP lẫn OAuth) — ép email phải match invite
      if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new ForbiddenException(
          'Signed-in account does not match this invitation',
        )
      }
    }

    if (!user) {
      throw new BadRequestException('Unable to resolve user for this invite')
    }

    // Nếu OTP nhánh mà user vừa được tạo → cần set JWT cookies
    if (body.method === 'otp' && (!currentUser || currentUser.id !== user.id) && res) {
      const { accessToken, refreshToken } = this.auth.generateTokens(
        user.id,
        user.email,
        user.name ?? null,
        user.avatar ?? null,
      )
      this.auth.setTokenCookies(res, accessToken, refreshToken)
    }

    // Check đã là member chưa
    const [existing] = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, user.id),
        ),
      )
      .limit(1)

    let workspace: Awaited<ReturnType<WorkspaceService['findOne']>>
    try {
      workspace = await this.workspaceService.findOne(invite.workspaceId, user.id)
    } catch {
      // fallback khi chưa phải member
      workspace = await this.fetchWorkspacePublic(invite.workspaceId)
    }

    if (existing) {
      // Idempotent: chỉ mark accepted nếu row pending, nhưng không chặn.
      // Cũng auto-add user vào TẤT CẢ channel mà email này đã được mời
      // (cover case user accept invite "workspace-only" trước, sau đó admin
      // gửi thêm invite cho channel → user vào workspace rồi nhưng channel
      // rows vẫn pending).
      await this.acceptPendingChannelInvitesForUser(
        invite.workspaceId,
        invite.email,
        user.id,
      )
      return { workspace, alreadyMember: true, userId: user.id }
    }

    await this.db.transaction(async tx => {
      await tx.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: invite.workspaceId,
        userId: user.id,
        role: 'member',
        email: user.email,
        name: user.name ?? null,
        avatar: user.avatar ?? null,
        timeZone: body.timeZone ?? null,
      })

      // Mark TẤT CẢ row pending cho (workspaceId, email) đã accepted
      // (không chỉ row có token hiện tại — cover multi-channel case).
      // Query 1 lần, update bulk.
      await tx
        .update(workspaceEmailInvites)
        .set({
          status: 'accepted',
          acceptedAt: new Date(),
          acceptedByUserId: user.id,
        })
        .where(
          and(
            eq(workspaceEmailInvites.workspaceId, invite.workspaceId),
            eq(workspaceEmailInvites.email, invite.email.toLowerCase()),
            eq(workspaceEmailInvites.status, 'pending'),
          ),
        )

      // Add channel_members cho từng channel (multi-channel).
      // onConflictDoNothing: nếu user đã là channel_member → bỏ qua, không throw.
      // Dùng programmatic insert loop thay vì INSERT...SELECT để drizzle typings
      // không phải build raw SQL wrapper cho literal values.
      const channelIdsToJoin = await tx
        .select({ channelId: workspaceEmailInvites.channelId })
        .from(workspaceEmailInvites)
        .where(
          and(
            eq(workspaceEmailInvites.workspaceId, invite.workspaceId),
            eq(workspaceEmailInvites.email, invite.email.toLowerCase()),
            eq(workspaceEmailInvites.status, 'pending'),
            sql`${workspaceEmailInvites.channelId} IS NOT NULL`,
          ),
        )

      for (const { channelId } of channelIdsToJoin) {
        if (!channelId) continue
        await tx
          .insert(channelMembers)
          .values({
            id: randomUUID(),
            channelId,
            userId: user.id,
            role: 'member',
          })
          .onConflictDoNothing({
            target: [channelMembers.channelId, channelMembers.userId],
          })
      }
    })

    // Cleanup Redis keys
    await this.redis.del(this.otpKey(invite.inviteId))
    await this.redis.del(this.verifiedKey(invite.inviteId))
    await this.redis.del(this.attemptsKey(invite.inviteId))
    await this.redis.del(this.lockedKey(invite.inviteId))
    await this.redis.del(this.cooldownKey(invite.inviteId))

    return { workspace, alreadyMember: false, userId: user.id }
  }

  private async acceptPendingChannelInvitesForUser(
    workspaceId: string,
    email: string,
    userIdParam: string,
  ): Promise<void> {
    const emailLower = email.toLowerCase()

    await this.db.transaction(async tx => {
      // Mark các row pending → accepted (CÓ channelId)
      await tx
        .update(workspaceEmailInvites)
        .set({
          status: 'accepted',
          acceptedAt: new Date(),
          acceptedByUserId: userIdParam,
        })
        .where(
          and(
            eq(workspaceEmailInvites.workspaceId, workspaceId),
            eq(workspaceEmailInvites.email, emailLower),
            eq(workspaceEmailInvites.status, 'pending'),
            sql`${workspaceEmailInvites.channelId} IS NOT NULL`,
          ),
        )

      // Add channel_members cho từng channel
      const channelIdsToJoin = await tx
        .select({ channelId: workspaceEmailInvites.channelId })
        .from(workspaceEmailInvites)
        .where(
          and(
            eq(workspaceEmailInvites.workspaceId, workspaceId),
            eq(workspaceEmailInvites.email, emailLower),
            eq(workspaceEmailInvites.status, 'pending'),
            sql`${workspaceEmailInvites.channelId} IS NOT NULL`,
          ),
        )

      for (const { channelId } of channelIdsToJoin) {
        if (!channelId) continue
        await tx
          .insert(channelMembers)
          .values({
            id: randomUUID(),
            channelId,
            userId: userIdParam,
            role: 'member',
          })
          .onConflictDoNothing({
            target: [channelMembers.channelId, channelMembers.userId],
          })
      }
    })
  }

  private async findOrCreateUserByEmail(email: string, name?: string) {
    const [existing] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (existing) return existing

    const [created] = await this.db
      .insert(users)
      .values({
        email,
        name: name?.trim() ? name.trim() : null,
      })
      .returning()

    // Link email account (provider='email', providerAccountId=email).
    // Dùng raw SQL để dùng được ON CONFLICT mà không cần kéo full Drizzle schema.
    await this.db.execute(
      sql`INSERT INTO accounts (id, user_id, provider, provider_account_id)
          VALUES (${randomUUID()}, ${created.id}, 'email', ${email})
          ON CONFLICT DO NOTHING`,
    )

    return created
  }

  private async fetchWorkspacePublic(workspaceId: string) {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    if (!row) {
      throw new NotFoundException('Workspace not found')
    }
    return {
      ...row,
      role: 'member',
    } as Awaited<ReturnType<WorkspaceService['findOne']>>
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private generateOtpCode(): string {
    const max = 10 ** OTP_CODE_LENGTH
    const min = 10 ** (OTP_CODE_LENGTH - 1)
    return String(Math.floor(Math.random() * (max - min)) + min)
  }

  /**
   * Hash OTP code + inviteId thành 1 chuỗi để lưu Redis.
   * Tránh lưu raw code (nếu Redis bị leak thì attacker vẫn cần biết
   * inviteId mà inviteId đã gắn với row `workspace_email_invites` rồi —
   * bảo vệ lớp 2 bằng `workspace_members` insert khi đã verify).
   */
  private hashOtp(code: string, inviteId: string): string {
    const crypto = require('crypto') as typeof import('crypto')
    return crypto
      .createHash('sha256')
      .update(`${inviteId}:${code}`)
      .digest('hex')
  }

  private timingSafeEqualStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    const crypto = require('crypto') as typeof import('crypto')
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  }

  private otpKey(id: string): string {
    return `invite-otp:${id}`
  }

  private cooldownKey(id: string): string {
    return `invite-otp-send-cooldown:${id}`
  }

  private verifiedKey(id: string): string {
    return `invite-verified:${id}`
  }

  private attemptsKey(id: string): string {
    return `invite-otp-attempts:${id}`
  }

  private lockedKey(id: string): string {
    return `invite-locked:${id}`
  }

  /**
   * Dev-only: trả về raw OTP code đang active cho inviteId, bằng cách
   * brute-force 6-digit code (1M case — chấp nhận được trong môi trường dev).
   * Production: throw, hoặc không có method này.
   */
  async devGetRawOtp(inviteId: string): Promise<{ code: string }> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Not available in production')
    }
    const stored = await this.redis.get(this.otpKey(inviteId))
    if (!stored) throw new Error('No active OTP')

    for (let i = 0; i < 10 ** OTP_CODE_LENGTH; i++) {
      const code = String(i).padStart(OTP_CODE_LENGTH, '0')
      const hash = this.hashOtp(code, inviteId)
      if (hash === stored) {
        return { code }
      }
    }
    throw new Error('Could not brute-force OTP')
  }
}
