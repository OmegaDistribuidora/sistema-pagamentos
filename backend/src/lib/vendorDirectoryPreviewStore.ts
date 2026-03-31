import { randomUUID } from "node:crypto";

type VendorDirectoryPreviewRow = {
  supervisorCode: number;
  vendorCode: number;
  vendorName: string;
};

type VendorDirectoryPreviewSession = {
  token: string;
  createdAt: number;
  expiresAt: number;
  originalFileName: string;
  rows: VendorDirectoryPreviewRow[];
};

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, VendorDirectoryPreviewSession>();

function cleanup(): void {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function createVendorDirectoryPreviewSession(
  payload: Omit<VendorDirectoryPreviewSession, "token" | "createdAt" | "expiresAt">
): VendorDirectoryPreviewSession {
  cleanup();
  const token = randomUUID();
  const now = Date.now();
  const session: VendorDirectoryPreviewSession = {
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    ...payload
  };
  sessions.set(token, session);
  return session;
}

export function consumeVendorDirectoryPreviewSession(token: string): VendorDirectoryPreviewSession | null {
  cleanup();
  const session = sessions.get(token) || null;
  if (session) {
    sessions.delete(token);
  }
  return session;
}
