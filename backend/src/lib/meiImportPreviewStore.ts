import { randomUUID } from "node:crypto";

type PreviewRow = {
  periodStart: string | null;
  periodEnd: string | null;
  supervisorCode: number;
  vendorCode: number;
  vendorName: string;
  grossSales: number;
  returnsAmount: number;
  netSales: number;
  advanceAmount: number;
  delinquencyAmount: number;
  grossCommission: number;
  averageCommissionPercent: number;
  reversalAmount: number;
  totalCommissionToInvoice: number;
  commissionToReceive: number;
};

type PreviewSession = {
  token: string;
  createdAt: number;
  expiresAt: number;
  referenceMonth: string;
  originalFileName: string;
  fileBuffer: Buffer;
  rows: PreviewRow[];
};

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, PreviewSession>();

function cleanup(): void {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function createPreviewSession(payload: Omit<PreviewSession, "token" | "createdAt" | "expiresAt">): PreviewSession {
  cleanup();
  const token = randomUUID();
  const now = Date.now();
  const session: PreviewSession = {
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ...payload
  };
  sessions.set(token, session);
  return session;
}

export function getPreviewSession(token: string): PreviewSession | null {
  cleanup();
  return sessions.get(token) || null;
}

export function consumePreviewSession(token: string): PreviewSession | null {
  cleanup();
  const session = sessions.get(token) || null;
  if (session) {
    sessions.delete(token);
  }
  return session;
}
