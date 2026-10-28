import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as nodemailer from 'nodemailer'

interface SendEmailOptions {
  to: string
  subject: string
  html: string
}

/**
 * MailService — gửi email qua SMTP (mặc định Mailtrap cho dev).
 *
 * Cấu hình qua env:
 *   MAILTRAP_HOST  (mặc định: sandbox.smtp.mailtrap.io)
 *   MAILTRAP_PORT  (mặc định: 2525)
 *   MAILTRAP_USER  (bắt buộc)
 *   MAILTRAP_PASS  (bắt buộc)
 *   MAIL_FROM      (mặc định: Slack Clone <noreply@slack-clone.local>)
 *
 * Lấy credentials tại https://mailtrap.io → Email Testing → Inboxes → SMTP Settings.
 */
@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter
  private readonly logger = new Logger(MailService.name)

  constructor(private config: ConfigService) {
    const user = this.config.get<string>('MAILTRAP_USER')
    const pass = this.config.get<string>('MAILTRAP_PASS')

    if (!user || !pass) {
      this.logger.warn(
        'MAILTRAP_USER / MAILTRAP_PASS chưa được set — email sẽ không gửi được. Kiểm tra .env',
      )
    }

    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('MAILTRAP_HOST', 'sandbox.smtp.mailtrap.io'),
      port: Number(this.config.get<string>('MAILTRAP_PORT', '2525')),
      secure: false,
      auth: { user, pass },
    })
  }

  private get from(): string {
    return this.config.get<string>(
      'MAIL_FROM',
      'Slack Clone <noreply@slack-clone.local>',
    )
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  private async send(opts: SendEmailOptions): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(`Mail error sending to ${opts.to}: ${message}`)
      throw new Error(message)
    }
  }

  async sendMagicLink(email: string, magicUrl: string): Promise<void> {
    await this.send({
      to: email,
      subject: 'Your magic link to sign in to Slack Clone',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto; padding:24px;">
          <h2 style="color:#3b1141; margin-bottom:8px;">Sign in to Slack Clone</h2>
          <p style="color:#555; margin-bottom:24px;">
            Click the button below to sign in. This link expires in <strong>15 minutes</strong>.
          </p>
          <a href="${magicUrl}"
             style="background:#3b1141; color:white; padding:14px 28px; border-radius:6px;
                    text-decoration:none; display:inline-block; font-weight:600; font-size:16px;">
            Sign In
          </a>
          <p style="color:#888; margin-top:24px; font-size:13px;">
            Or copy and paste this URL into your browser:<br/>
            <a href="${magicUrl}" style="color:#3b1141; word-break:break-all;">${magicUrl}</a>
          </p>
          <p style="color:#aaa; margin-top:16px; font-size:12px;">
            If you didn't request this email, you can safely ignore it.
          </p>
        </div>
      `,
    })
  }

  /**
   * Gửi email mời vào workspace (link /join/email-invite/{token}).
   * KHÔNG nhắc channel trong body — channel assignments xảy ra khi user
   * accept invite (xem `acceptInvite`).
   */
  async sendWorkspaceInvite(
    email: string,
    inviterName: string,
    workspaceName: string,
    inviteUrl: string,
  ): Promise<void> {
    const subInv = inviterName.replace(/\s+/g, ' ').trim()
    const subWs = workspaceName.replace(/\s+/g, ' ').trim()
    const subject = `${subInv} invited you to join ${subWs} on Slack Clone`

    await this.send({
      to: email,
      subject,
      html: `
        <div style="font-family:sans-serif; max-width:520px; margin:0 auto; padding:32px; background:#fff;">
          <div style="text-align:center; margin-bottom:32px;">
            <div style="display:inline-block; background:#3b1141; padding:12px 24px; border-radius:8px;">
              <span style="color:white; font-size:20px; font-weight:700; letter-spacing:1px;">Slack Clone</span>
            </div>
          </div>

          <h2 style="color:#1d1c1d; font-size:24px; margin-bottom:8px;">You're invited!</h2>
          <p style="color:#454245; font-size:16px; margin-bottom:4px;">
            <strong>${this.escapeHtml(inviterName)}</strong> has invited you to join the
            <strong>${this.escapeHtml(workspaceName)}</strong> workspace on Slack Clone.
          </p>
          <p style="color:#616061; font-size:14px; margin-bottom:28px;">
            Click the button below to accept the invitation and get started.
          </p>

          <a href="${this.escapeHtml(inviteUrl)}"
             style="background:#3b1141; color:white; padding:14px 32px; border-radius:6px;
                    text-decoration:none; display:inline-block; font-weight:600; font-size:16px;">
            Accept Invitation
          </a>

          <hr style="border:none; border-top:1px solid #e8e8e8; margin:32px 0;" />

          <p style="color:#888; font-size:13px; margin-bottom:4px;">
            Or copy and paste this link into your browser:
          </p>
          <a href="${this.escapeHtml(inviteUrl)}" style="color:#3b1141; font-size:13px; word-break:break-all;">
            ${this.escapeHtml(inviteUrl)}
          </a>

          <p style="color:#aaa; font-size:12px; margin-top:24px;">
            This invitation was sent to ${this.escapeHtml(email)}. If you were not expecting this,
            you can safely ignore this email.
          </p>
        </div>
      `,
    })
  }

  /**
   * Gửi mã OTP 6 số để xác minh email khi user nhận lời mời workspace.
   * Template đơn giản, làm nổi bật số để user dễ thấy.
   */
  async sendOtpCode(
    email: string,
    code: string,
    workspaceName: string,
  ): Promise<void> {
    await this.send({
      to: email,
      subject: `Your verification code for ${workspaceName} on Slack Clone`,
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto; padding:32px; background:#fff;">
          <div style="text-align:center; margin-bottom:24px;">
            <div style="display:inline-block; background:#3b1141; padding:10px 20px; border-radius:8px;">
              <span style="color:white; font-size:18px; font-weight:700; letter-spacing:1px;">Slack Clone</span>
            </div>
          </div>

          <h2 style="color:#1d1c1d; font-size:22px; margin-bottom:8px;">
            Verify your email to join <strong>${this.escapeHtml(workspaceName)}</strong>
          </h2>
          <p style="color:#454245; font-size:15px; margin-bottom:24px;">
            Use this 6-digit code on the invitation page. The code expires in
            <strong>10 minutes</strong>.
          </p>

          <div style="background:#f4f4f6; border-radius:8px; padding:24px; text-align:center; margin-bottom:24px;">
            <span style="font-size:36px; font-weight:700; letter-spacing:8px; color:#3b1141; font-family:monospace;">
              ${this.escapeHtml(code)}
            </span>
          </div>

          <p style="color:#888; font-size:13px; margin-bottom:0;">
            If you didn't request this code, you can safely ignore this email.
          </p>
        </div>
      `,
    })
  }
}
