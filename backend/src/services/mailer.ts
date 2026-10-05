import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

let transporter: Transporter | null = null;

export function mailConfigured() {
  return Boolean(config.SMTP_HOST);
}

function getTransport() {
  if (!config.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      requireTLS: config.SMTP_PORT !== 465
    });
  }
  return transporter;
}

/** Sends an email. Returns false (and logs) when SMTP is not configured; callers record the outcome. */
export async function sendMail(to: string | string[], subject: string, text: string): Promise<{ sent: boolean; error?: string }> {
  const t = getTransport();
  if (!t) {
    logger.info({ to, subject }, 'SMTP not configured — email not sent');
    return { sent: false, error: 'SMTP not configured' };
  }
  try {
    await t.sendMail({ from: config.SMTP_FROM, to, subject, text });
    return { sent: true };
  } catch (err: any) {
    logger.error({ err: err.message, subject }, 'email send failed');
    return { sent: false, error: err.message };
  }
}
