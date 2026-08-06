import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config/schema.js';
import type { Digest } from '../domain/digest.js';
import type { RenderedDigest } from './render.js';
import type { Notifier } from './types.js';

type EmailConfig = NonNullable<Config['email']>;

export class EmailNotifier implements Notifier {
  readonly channel = 'email' as const;
  private transporter: Transporter;

  constructor(
    private readonly config: EmailConfig,
    transporter?: Transporter,
  ) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass ?? '' } : undefined,
        tls: { rejectUnauthorized: config.smtp.reject_unauthorized },
      });
  }

  async send(digest: Digest, rendered: RenderedDigest): Promise<void> {
    const to = digest.recipient.email;
    if (!to) {
      throw new Error(`recipient ${digest.username} has no email address`);
    }

    await this.transporter.sendMail({
      from: this.config.from,
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  }

  /** Opens an SMTP connection and authenticates without sending anything. */
  async verify(): Promise<void> {
    await this.transporter.verify();
  }
}
