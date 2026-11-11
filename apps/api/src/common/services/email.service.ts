/**
 * Outbound email over SMTP (Gmail, or any SMTP host).
 *
 * Design mirrors the Telegram client on purpose, because both are "an external channel that must
 * never break the thing that uses it":
 *
 *  - **Optional.** With no SMTP configuration the service reports `configured: false` and the
 *    callers say so in the UI, instead of pretending a code was mailed.
 *  - **Bounded.** Connection, greeting and socket timeouts are all set; a dead SMTP host cannot
 *    hang a login request.
 *  - **Never throws.** `send()` returns a result. An OTP flow that cannot email still returns a
 *    truthful "not delivered" answer rather than a 500 the user cannot act on.
 *  - **No credentials in logs.** Errors are redacted the same way Telegram errors are.
 *
 * `nodemailer` was already a dependency of the API; this is its first use.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  delivered: boolean;
  error: string | null;
  /** True when no SMTP configuration exists — a deployment fact, not a failure. */
  notConfigured?: boolean;
}

export interface SmtpConfiguration {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/** Anything that looks like a password or key is stripped before an error is stored or logged. */
export function redactEmailError(message: string): string {
  return message
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-token>')
    .replace(/(password|pass|auth|token|key)\s*[:=]\s*\S+/gi, '$1=<redacted>');
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger('Email');
  private readonly config: SmtpConfiguration | null;
  private transport: Transporter | null = null;

  constructor(options: { config?: SmtpConfiguration | null; transport?: Transporter | null } = {}) {
    this.config = options.config === undefined ? EmailService.configFromEnv() : options.config;
    if (options.transport) this.transport = options.transport;
  }

  static configFromEnv(): SmtpConfiguration | null {
    const host = process.env.SMTP_HOST?.trim();
    const from = process.env.SMTP_FROM?.trim();
    if (!host || !from) return null;
    const port = Number(process.env.SMTP_PORT ?? 587);
    return {
      host,
      port: Number.isFinite(port) ? port : 587,
      // 465 is implicit TLS; 587 uses STARTTLS. Getting this wrong makes every send hang.
      secure: (process.env.SMTP_SECURE ?? (port === 465 ? 'true' : 'false')) === 'true',
      user: process.env.SMTP_USER?.trim() || undefined,
      pass: process.env.SMTP_PASS || undefined,
      from,
    };
  }

  get configured(): boolean {
    return this.config !== null;
  }

  /** Exposed for the admin diagnostics surface: which host, never the credentials. */
  describe(): { configured: boolean; host: string | null; port: number | null; from: string | null } {
    return {
      configured: this.configured,
      host: this.config?.host ?? null,
      port: this.config?.port ?? null,
      from: this.config?.from ?? null,
    };
  }

  private transporter(): Transporter {
    if (this.transport) return this.transport;
    if (!this.config) throw new Error('SMTP is not configured');
    this.transport = createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: this.config.user ? { user: this.config.user, pass: this.config.pass } : undefined,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10_000,
      // Gmail rewrites From; using the authenticated address as envelope sender keeps SPF sane.
      ...(this.config.user ? { envelope: { from: this.config.user } } : {}),
    });
    return this.transport;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    if (!this.config) {
      return { delivered: false, error: 'SMTP is not configured (set SMTP_HOST and SMTP_FROM)', notConfigured: true };
    }
    try {
      const info = await this.transporter().sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      if (info.rejected?.length) {
        return { delivered: false, error: `SMTP rejected the recipient: ${String(info.rejected[0])}` };
      }
      return { delivered: true, error: null };
    } catch (error) {
      const message_ = redactEmailError((error as Error)?.message ?? 'SMTP send failed');
      this.logger.warn(`email to ${maskAddress(message.to)} failed: ${message_}`);
      return { delivered: false, error: message_ };
    }
  }
}

/** `someone@example.com` → `s•••e@example.com`: enough to recognise, useless as an address. */
export function maskAddress(address: string): string {
  const [local, domain] = address.split('@');
  if (!domain) return '•••';
  const visible = local.length <= 2 ? local.slice(0, 1) : `${local[0]}${'•'.repeat(Math.min(3, local.length - 2))}${local[local.length - 1]}`;
  return `${visible}@${domain}`;
}
