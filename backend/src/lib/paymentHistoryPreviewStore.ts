import { randomUUID } from "node:crypto";
import type { PaymentHistoryInput } from "./paymentHistoryExcel";

export type PaymentHistoryImportPreview = {
  userId: number;
  originalFileName: string;
  rows: PaymentHistoryInput[];
  finalRows: PaymentHistoryInput[];
  createdCount: number;
  updatedCount: number;
  considerationCount: number;
  duplicateUploadCount: number;
  conflicts: Array<{
    id: number;
    personCode: number;
    personName: string;
    event: string;
    month: number;
    year: number;
    existingCount: number;
  }>;
};

type StoredPreview = PaymentHistoryImportPreview & {
  expiresAt: number;
};

const sessions = new Map<string, StoredPreview>();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function cleanup(): void {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function createPaymentHistoryPreview(preview: PaymentHistoryImportPreview): string {
  cleanup();
  const token = randomUUID();
  sessions.set(token, {
    ...preview,
    expiresAt: Date.now() + PREVIEW_TTL_MS
  });
  return token;
}

export function consumePaymentHistoryPreview(token: string, userId: number): PaymentHistoryImportPreview | null {
  cleanup();
  const session = sessions.get(token);
  if (!session || session.userId !== userId) return null;
  sessions.delete(token);
  const { expiresAt: _expiresAt, ...preview } = session;
  return preview;
}
