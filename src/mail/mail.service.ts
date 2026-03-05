import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Resend } from 'resend'

@Injectable()
export class MailService {
  private resend: Resend
  private readonly logger = new Logger(MailService.name)

  constructor(private config: ConfigService) {
    this.resend = new Resend(this.config.get<string>('RESEND_API_KEY'))
  }

  async sendMagicLink(email: string, magicUrl: string): Promise<void> {
    const from = this.config.get<string>(
      'MAIL_FROM',
      'Slack Clone <onboarding@resend.dev>',
    )

    const { error } = await this.resend.emails.send({
      from,
      to: email,
      subject: 'Your magic link to sign in to Slack Clone',
      html: `
        <div style="font-family:sans-serifmax-width:480pxmargin:0 autopadding:24px">
          <h2 style="color:#3b1141margin-bottom:8px">Sign in to Slack Clone</h2>
          <p style="color:#555margin-bottom:24px">
            Click the button below to sign in. This link expires in <strong>15 minutes</strong>.
          </p>
          <a href="${magicUrl}"
             style="background:#3b1141color:whitepadding:14px 28pxborder-radius:6px
                    text-decoration:nonedisplay:inline-blockfont-weight:600font-size:16px">
            Sign In
          </a>
          <p style="color:#888margin-top:24pxfont-size:13px">
            Or copy and paste this URL into your browser:<br/>
            <a href="${magicUrl}" style="color:#3b1141word-break:break-all">${magicUrl}</a>
          </p>
          <p style="color:#aaamargin-top:16pxfont-size:12px">
            If you didn't request this email, you can safely ignore it.
          </p>
        </div>
      `,
    })

    if (error) {
      this.logger.error('Failed to send magic link email', error)
      throw new Error('Failed to send magic link email')
    }
  }
}
