import nodemailer from "nodemailer";
import { env } from "../config";

type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachment?: EmailAttachment | null;
};

let transporter: nodemailer.Transporter | null = null;

function buildFromAddress(): string {
  const fromEmail = env.ses.fromEmail;
  const fromName = env.ses.fromName;

  if (!fromEmail) {
    return "";
  }

  return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
}

function getTransporter(): nodemailer.Transporter {
  if (transporter) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: env.ses.host,
    port: env.ses.port,
    secure: env.ses.secure,
    auth: {
      user: env.ses.username,
      pass: env.ses.password
    }
  });

  return transporter;
}

export function isEmailDeliveryConfigured(): boolean {
  return Boolean(env.ses.host && env.ses.port && env.ses.username && env.ses.password && env.ses.fromEmail);
}

export function getEmailProviderName(): string {
  return "amazon-ses-smtp";
}

export async function sendTransactionalEmail(input: SendEmailInput): Promise<{ id: string | null }> {
  if (!isEmailDeliveryConfigured()) {
    throw new Error("O envio por email via Amazon SES SMTP ainda nao esta configurado.");
  }

  const info = await getTransporter().sendMail({
    from: buildFromAddress(),
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: input.attachment
      ? [
          {
            filename: input.attachment.filename,
            content: input.attachment.content,
            contentType: input.attachment.contentType || "application/octet-stream"
          }
        ]
      : undefined
  });

  return {
    id: info.messageId || null
  };
}
