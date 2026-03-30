import prisma from "./prisma";
import type { AppUserRole, AuthUser } from "../types";

type AuditPrismaClient = {
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
};

type AuditSnapshotUser = {
  id: number;
  username: string;
  displayName: string;
  role: AppUserRole;
};

type AuditEvent = {
  actor?: AuthUser | null;
  actorUser?: AuditSnapshotUser | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
};

function normalizeJson(value: unknown): unknown {
  return value ?? null;
}

function buildActorSnapshot({
  actor,
  actorUser
}: {
  actor?: AuthUser | null;
  actorUser?: AuditSnapshotUser | null;
}) {
  return {
    actorUserId: actor?.userId ?? actorUser?.id,
    actorUsername: actor?.username ?? actorUser?.username,
    actorDisplayName: actorUser?.displayName,
    actorRole: actor?.role ?? actorUser?.role
  };
}

export async function recordAudit(event: AuditEvent, client: AuditPrismaClient = prisma): Promise<void> {
  const actorSnapshot = buildActorSnapshot({
    actor: event.actor,
    actorUser: event.actorUser
  });

  const data: Record<string, unknown> = {
    action: event.action,
    entityType: event.entityType,
    summary: event.summary,
    ...(actorSnapshot.actorUserId != null ? { actorUserId: actorSnapshot.actorUserId } : {}),
    ...(actorSnapshot.actorUsername ? { actorUsername: actorSnapshot.actorUsername } : {}),
    ...(actorSnapshot.actorDisplayName ? { actorDisplayName: actorSnapshot.actorDisplayName } : {}),
    ...(actorSnapshot.actorRole ? { actorRole: actorSnapshot.actorRole } : {}),
    ...(event.entityId != null ? { entityId: String(event.entityId) } : {}),
    ...(event.before !== undefined ? { before: normalizeJson(event.before) } : {}),
    ...(event.after !== undefined ? { after: normalizeJson(event.after) } : {}),
    ...(event.metadata !== undefined ? { metadata: normalizeJson(event.metadata) } : {})
  };

  await client.auditLog.create({ data });
}
