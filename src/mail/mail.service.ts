import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Resend } from 'resend'

interface SendEmailOptions {
  to: string
  subject: string
  html: string
}

@Injectable()
export class MailService {
  private resend: Resend
  private readonly logger = new Logger(MailService.name)

  constructor(private config: ConfigService) {
    this.resend = new Resend(this.config.get<string>('RESEND_API_KEY'))
  }

  private get from(): string {
    return this.config.get<string>(
      'MAIL_FROM',
      'Slack Clone <onboarding@resend.dev>',
    )
  }

  private async send(opts: SendEmailOptions): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    })

    if (error) {
      this.logger.error(`Resend error sending to ${opts.to}`, error)
      throw new Error(error.message)
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

  async sendWorkspaceInvite(
    email: string,
    inviterName: string,
    workspaceName: string,
    inviteUrl: string,
  ): Promise<void> {
    await this.send({
      to: email,
      subject: `${inviterName} invited you to join ${workspaceName} on Slack Clone`,
      html: `
        <div style="font-family:sans-serif; max-width:520px; margin:0 auto; padding:32px; background:#fff;">
          <div style="text-align:center; margin-bottom:32px;">
            <div style="display:inline-block; background:#3b1141; padding:12px 24px; border-radius:8px;">
              <span style="color:white; font-size:20px; font-weight:700; letter-spacing:1px;">Slack Clone</span>
            </div>
          </div>

          <h2 style="color:#1d1c1d; font-size:24px; margin-bottom:8px;">You're invited!</h2>
          <p style="color:#454245; font-size:16px; margin-bottom:4px;">
            <strong>${inviterName}</strong> has invited you to join the
            <strong>${workspaceName}</strong> workspace on Slack Clone.
          </p>
          <p style="color:#616061; font-size:14px; margin-bottom:28px;">
            Click the button below to accept the invitation and get started.
          </p>

          <a href="${inviteUrl}"
             style="background:#3b1141; color:white; padding:14px 32px; border-radius:6px;
                    text-decoration:none; display:inline-block; font-weight:600; font-size:16px;">
            Accept Invitation
          </a>

          <hr style="border:none; border-top:1px solid #e8e8e8; margin:32px 0;" />

          <p style="color:#888; font-size:13px; margin-bottom:4px;">
            Or copy and paste this link into your browser:
          </p>
          <a href="${inviteUrl}" style="color:#3b1141; font-size:13px; word-break:break-all;">
            ${inviteUrl}
          </a>

          <p style="color:#aaa; font-size:12px; margin-top:24px;">
            This invitation was sent to ${email}. If you were not expecting this,
            you can safely ignore this email.
          </p>
        </div>
      `,
    })
  }
}
