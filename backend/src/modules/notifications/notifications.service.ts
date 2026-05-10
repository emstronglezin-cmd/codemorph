// ============================================================
// CodeMorph — Notifications Service (Email via Resend/SMTP)
// ============================================================
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EmailPayload {
  to:      string;
  subject: string;
  html:    string;
  text?:   string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly config: ConfigService) {}

  // ── Send email ────────────────────────────────────────
  async sendEmail(payload: EmailPayload): Promise<void> {
    const isDev = this.config.get<string>('app.env') !== 'production';

    if (isDev) {
      this.logger.log(`[DEV EMAIL] To: ${payload.to} | Subject: ${payload.subject}`);
      return;
    }

    // TODO: integrate Resend / SendGrid / Nodemailer in production
    this.logger.log(`Email sent to ${payload.to}`);
  }

  // ── Email templates ───────────────────────────────────
  async sendWelcomeEmail(to: string, name: string): Promise<void> {
    await this.sendEmail({
      to,
      subject: 'Welcome to CodeMorph 🚀',
      html: `
        <h1>Welcome, ${name}!</h1>
        <p>Your CodeMorph account is ready. Start your first code conversion today.</p>
        <a href="${this.config.get('app.appUrl')}/dashboard">Go to Dashboard →</a>
      `,
    });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    await this.sendEmail({
      to,
      subject: 'Reset your CodeMorph password',
      html: `
        <h1>Password Reset</h1>
        <p>Click the link below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetUrl}">Reset Password →</a>
        <p>If you didn't request this, please ignore this email.</p>
      `,
    });
  }

  async sendConversionCompleteEmail(
    to: string,
    projectName: string,
    success: boolean,
  ): Promise<void> {
    await this.sendEmail({
      to,
      subject: success
        ? `✅ Conversion complete: ${projectName}`
        : `❌ Conversion failed: ${projectName}`,
      html: success
        ? `<h1>Conversion Complete!</h1><p>Your project <b>${projectName}</b> has been successfully converted.</p>`
        : `<h1>Conversion Failed</h1><p>Your project <b>${projectName}</b> encountered an error during conversion. Please check the details in your dashboard.</p>`,
    });
  }

  async sendTeamInvitationEmail(
    to: string,
    inviterName: string,
    orgName: string,
    inviteUrl: string,
  ): Promise<void> {
    await this.sendEmail({
      to,
      subject: `${inviterName} invited you to ${orgName} on CodeMorph`,
      html: `
        <h1>Team Invitation</h1>
        <p><b>${inviterName}</b> has invited you to join <b>${orgName}</b> on CodeMorph.</p>
        <a href="${inviteUrl}">Accept Invitation →</a>
      `,
    });
  }
}
