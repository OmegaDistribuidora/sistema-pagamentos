import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

process.env.TZ = "America/Sao_Paulo";

function parseNormalizedList(value: string | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(process.cwd(), "backend", ".env")
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const defaultUploadsDir = path.resolve(process.cwd(), "..", "backend", "uploads");

export const env = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: String(process.env.NODE_ENV || "development").trim(),
  jwtSecret: String(process.env.JWT_SECRET || "change-me").trim(),
  databaseUrl: String(process.env.DATABASE_URL || "").trim(),
  adminUsername: String(process.env.ADMIN_USERNAME || "admin").trim().toLowerCase(),
  adminPassword: String(process.env.ADMIN_PASSWORD || "Omega@123"),
  adminDisplayName: String(process.env.ADMIN_DISPLAY_NAME || "Administrador").trim(),
  uploadsDir: path.resolve(process.cwd(), "..", String(process.env.UPLOADS_DIR || defaultUploadsDir)),
  frontendUrl: String(process.env.FRONTEND_URL || "http://localhost:5173").trim(),
  allowLocalLogin: String(process.env.NODE_ENV || "development").trim() !== "production",
  timeZone: "America/Sao_Paulo",
  ecosystemSso: {
    issuer: String(process.env.ECOSYSTEM_SSO_ISSUER || "ecosistema-omega").trim(),
    audience: String(process.env.ECOSYSTEM_SSO_AUDIENCE || "sistema-pagamentos").trim(),
    sharedSecret: String(process.env.ECOSYSTEM_SSO_SHARED_SECRET || "").trim(),
    adminUsers: parseNormalizedList(process.env.ECOSYSTEM_SSO_ADMIN_USERS)
  },
  ses: {
    host: String(process.env.SES_SMTP_HOST || "email-smtp.sa-east-1.amazonaws.com").trim(),
    port: Number(process.env.SES_SMTP_PORT || 587),
    secure: String(process.env.SES_SMTP_SECURE || "false").trim().toLowerCase() === "true",
    username: String(process.env.SES_SMTP_USERNAME || "").trim(),
    password: String(process.env.SES_SMTP_PASSWORD || "").trim(),
    fromEmail: String(process.env.SES_FROM_EMAIL || "comercial.4@omegadistribuidora.com.br").trim(),
    fromName: String(process.env.SES_FROM_NAME || "Sistema de Pagamentos").trim()
  }
};
