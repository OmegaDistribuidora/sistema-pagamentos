import type { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import { hashPassword, requireAdmin, requireAuth, signToken } from "../lib/security";
import { getEffectiveSupervisorCodes, normalizeSupervisorCodesInput } from "../lib/userSupervisorCodes";
import type { AppUserRole } from "../types";

const createUserSchema = z.object({
  username: z.string().min(2),
  displayName: z.string().min(2),
  password: z.string().min(6),
  role: z.enum(["ADMIN", "USER"]),
  supervisorCode: z.number().int().positive().nullable().optional(),
  supervisorCodes: z.array(z.coerce.number().int().positive()).optional(),
  active: z.boolean().default(true)
});

const updateUserSchema = createUserSchema.extend({
  password: z.string().min(6).optional().or(z.literal(""))
});

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSupervisorAssignment(
  role: "ADMIN" | "USER",
  supervisorCodes: Array<number | string | null | undefined> | undefined,
  legacySupervisorCode: number | null | undefined
): { supervisorCode: number | null; supervisorCodes: number[] } {
  if (role === "ADMIN") {
    return {
      supervisorCode: null,
      supervisorCodes: []
    };
  }

  const normalizedCodes = normalizeSupervisorCodesInput([
    ...(supervisorCodes || []),
    ...(supervisorCodes?.length ? [] : [legacySupervisorCode])
  ]);

  if (!normalizedCodes.length) {
    throw new Error("Informe ao menos um codigo de supervisor para usuarios do tipo user.");
  }

  return {
    supervisorCode: normalizedCodes[0],
    supervisorCodes: normalizedCodes
  };
}

function serializeUser(user: {
  id: number;
  username: string;
  displayName: string;
  role: AppUserRole;
  supervisorCode: number | null;
  supervisorCodes?: number[] | null;
  active: boolean;
  createdAt: Date;
}) {
  const supervisorCodes = getEffectiveSupervisorCodes(user);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    supervisorCode: supervisorCodes[0] ?? null,
    supervisorCodes,
    active: user.active,
    createdAt: user.createdAt
  };
}

async function countActiveAdmins(): Promise<number> {
  return prisma.user.count({
    where: {
      role: "ADMIN",
      active: true
    }
  });
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/users", { preHandler: [requireAuth, requireAdmin] }, async () => {
    const users = await prisma.user.findMany({
      orderBy: [{ role: "asc" }, { username: "asc" }]
    });

    return {
      users: users.map(serializeUser)
    };
  });

  app.post("/api/users", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados do usuario invalidos." });
    }

    const username = normalizeUsername(parsed.data.username);
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return reply.code(409).send({ message: "Ja existe um usuario com esse login." });
    }

    let supervisorAssignment: { supervisorCode: number | null; supervisorCodes: number[] };
    try {
      supervisorAssignment = normalizeSupervisorAssignment(
        parsed.data.role,
        parsed.data.supervisorCodes,
        parsed.data.supervisorCode ?? null
      );
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Codigo de supervisor invalido." });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const authUser = request.authUser;

    const user = await prisma.$transaction(async (tx: any) => {
      const createdUser = await tx.user.create({
        data: {
          username,
          displayName: parsed.data.displayName.trim(),
          passwordHash,
          role: parsed.data.role,
          supervisorCode: supervisorAssignment.supervisorCode,
          supervisorCodes: supervisorAssignment.supervisorCodes,
          active: parsed.data.active
        }
      });

      await recordAudit(
        {
          actor: authUser,
          action: "CREATE_USER",
          entityType: "USER",
          entityId: createdUser.id,
          summary: `${createdUser.displayName} foi criado.`,
          before: null,
          after: serializeUser(createdUser)
        },
        tx
      );

      return createdUser;
    });

    return reply.code(201).send({ user: serializeUser(user) });
  });

  app.put("/api/users/:id", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const userId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return reply.code(400).send({ message: "Usuario invalido." });
    }

    const parsed = updateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados do usuario invalidos." });
    }

    const current = await prisma.user.findUnique({ where: { id: userId } });
    if (!current) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const username = normalizeUsername(parsed.data.username);
    const owner = await prisma.user.findUnique({ where: { username } });
    if (owner && owner.id !== userId) {
      return reply.code(409).send({ message: "Ja existe um usuario com esse login." });
    }

    let supervisorAssignment: { supervisorCode: number | null; supervisorCodes: number[] };
    try {
      supervisorAssignment = normalizeSupervisorAssignment(
        parsed.data.role,
        parsed.data.supervisorCodes,
        parsed.data.supervisorCode ?? null
      );
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Codigo de supervisor invalido." });
    }

    const activeAdmins = await countActiveAdmins();
    if (
      current.role === "ADMIN" &&
      current.active &&
      activeAdmins <= 1 &&
      (parsed.data.role !== "ADMIN" || parsed.data.active === false)
    ) {
      return reply.code(400).send({ message: "Nao e possivel remover o ultimo administrador ativo." });
    }

    const authUser = request.authUser;
    const beforeSnapshot = serializeUser(current);

    const updated = await prisma.$transaction(async (tx: any) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          username,
          displayName: parsed.data.displayName.trim(),
          role: parsed.data.role,
          supervisorCode: supervisorAssignment.supervisorCode,
          supervisorCodes: supervisorAssignment.supervisorCodes,
          active: parsed.data.active,
          ...(parsed.data.password && parsed.data.password.trim()
            ? { passwordHash: await hashPassword(parsed.data.password.trim()) }
            : {})
        }
      });

      await recordAudit(
        {
          actor: authUser,
          action: "UPDATE_USER",
          entityType: "USER",
          entityId: userId,
          summary: `${user.displayName} foi atualizado.`,
          before: beforeSnapshot,
          after: serializeUser(user)
        },
        tx
      );

      return user;
    });

    return {
      user: serializeUser(updated),
      ...(authUser?.userId === updated.id
        ? {
            sessionToken: signToken({
              userId: updated.id,
              username: updated.username,
              role: updated.role
            })
          }
        : {})
    };
  });

  app.delete("/api/users/:id", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const userId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return reply.code(400).send({ message: "Usuario invalido." });
    }

    const current = await prisma.user.findUnique({ where: { id: userId } });
    if (!current) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    if (request.authUser?.userId === current.id) {
      return reply.code(400).send({ message: "Nao e permitido remover o proprio usuario." });
    }

    const activeAdmins = await countActiveAdmins();
    if (current.role === "ADMIN" && current.active && activeAdmins <= 1) {
      return reply.code(400).send({ message: "Nao e possivel remover o ultimo administrador ativo." });
    }

    const authUser = request.authUser;
    const beforeSnapshot = serializeUser(current);

    await prisma.$transaction(async (tx: any) => {
      await tx.user.delete({
        where: { id: userId }
      });

      await recordAudit(
        {
          actor: authUser,
          action: "DELETE_USER",
          entityType: "USER",
          entityId: userId,
          summary: `${current.displayName} foi excluido.`,
          before: beforeSnapshot,
          after: null
        },
        tx
      );
    });

    return reply.code(204).send();
  });
}
