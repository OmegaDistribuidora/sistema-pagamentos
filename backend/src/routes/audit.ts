import type { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";
import { requireAdmin, requireAuth } from "../lib/security";

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/audit", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 400
    });

    return {
      logs: logs.map((log) => ({
        id: log.id,
        actorUserId: log.actorUserId,
        actorUsername: log.actorUsername,
        actorDisplayName: log.actorDisplayName,
        actorRole: log.actorRole,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        summary: log.summary,
        before: log.before,
        after: log.after,
        metadata: log.metadata,
        createdAt: log.createdAt
      }))
    };
  });
}
