import type { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import { parseVendorDirectorySpreadsheet } from "../lib/vendorDirectoryExcel";
import { requireAdmin, requireAuth } from "../lib/security";

const saveVendorEmailSchema = z.object({
  vendorCode: z.coerce.number().int().positive(),
  email: z.string().trim().email().or(z.literal(""))
});

const updateVendorDirectorySchema = z.object({
  supervisorCode: z.coerce.number().int().nonnegative(),
  vendorName: z.string().trim().min(1).max(255)
});

async function getActiveUser(userId: number) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      supervisorCode: true,
      active: true
    }
  });
}

function serializeVendorRecord(record: { supervisorCode: number; vendorCode: number; vendorName: string }, email: string) {
  return {
    supervisorCode: record.supervisorCode,
    vendorCode: record.vendorCode,
    vendorName: record.vendorName,
    email
  };
}

export async function registerVendorDirectoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vendor-directory", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const records = await prisma.vendorDirectoryEntry.findMany({
      where: user.role === "USER" ? { supervisorCode: user.supervisorCode || -1 } : undefined,
      orderBy: [{ supervisorCode: "asc" }, { vendorName: "asc" }]
    });

    const vendorEmails = records.length
      ? await prisma.meiVendorEmail.findMany({
          where: {
            vendorCode: {
              in: records.map((record) => record.vendorCode)
            }
          }
        })
      : [];

    const emailByVendorCode = new Map(vendorEmails.map((item) => [item.vendorCode, item.email]));
    return {
      records: records.map((record) => serializeVendorRecord(record, emailByVendorCode.get(record.vendorCode) || ""))
    };
  });

  app.post("/api/vendor-directory/email", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const parsed = saveVendorEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados invalidos para salvar email." });
    }

    const vendorRecord = await prisma.vendorDirectoryEntry.findUnique({
      where: { vendorCode: parsed.data.vendorCode }
    });

    if (!vendorRecord) {
      return reply.code(404).send({ message: "Vendedor nao encontrado na base geral." });
    }

    if (user.role === "USER" && vendorRecord.supervisorCode !== user.supervisorCode) {
      return reply.code(403).send({ message: "Sem acesso a este vendedor." });
    }

    const normalizedEmail = parsed.data.email.trim().toLowerCase();
    const existing = await prisma.meiVendorEmail.findUnique({
      where: { vendorCode: vendorRecord.vendorCode }
    });

    if (!normalizedEmail) {
      if (existing) {
        await prisma.meiVendorEmail.delete({ where: { vendorCode: vendorRecord.vendorCode } });

        await recordAudit({
          actor: authUser,
          action: "VENDOR_EMAIL_CLEAR",
          entityType: "VENDOR_DIRECTORY",
          entityId: vendorRecord.vendorCode,
          summary: `${user.displayName} removeu o email do vendedor ${vendorRecord.vendorName}.`,
          before: { email: existing.email },
          after: { email: null }
        });
      }

      return {
        message: "Email removido com sucesso.",
        record: serializeVendorRecord(vendorRecord, "")
      };
    }

    const saved = await prisma.meiVendorEmail.upsert({
      where: { vendorCode: vendorRecord.vendorCode },
      create: {
        vendorCode: vendorRecord.vendorCode,
        email: normalizedEmail
      },
      update: {
        email: normalizedEmail
      }
    });

    await recordAudit({
      actor: authUser,
      action: existing ? "VENDOR_EMAIL_UPDATE" : "VENDOR_EMAIL_CREATE",
      entityType: "VENDOR_DIRECTORY",
      entityId: vendorRecord.vendorCode,
      summary: `${user.displayName} salvou o email do vendedor ${vendorRecord.vendorName}.`,
      before: { email: existing?.email || null },
      after: { email: saved.email }
    });

    return {
      message: "Email salvo com sucesso.",
      record: serializeVendorRecord(vendorRecord, saved.email)
    };
  });

  app.post("/api/vendor-directory/import", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    try {
      const part = await request.file();
      if (!part) {
        return reply.code(400).send({ message: "Arquivo .xlsx obrigatorio." });
      }

      const buffer = await part.toBuffer();
      const rows = parseVendorDirectorySpreadsheet(buffer);
      const existingRecords = await prisma.vendorDirectoryEntry.findMany();
      const existingByVendorCode = new Map(existingRecords.map((item) => [item.vendorCode, item]));
      const incomingVendorCodes = new Set(rows.map((row) => row.vendorCode));

      let created = 0;
      let updated = 0;

      await prisma.$transaction(async (tx: any) => {
        for (const row of rows) {
          const existing = existingByVendorCode.get(row.vendorCode);
          if (!existing) {
            created += 1;
            await tx.vendorDirectoryEntry.create({ data: row });
            continue;
          }

          if (
            existing.supervisorCode !== row.supervisorCode ||
            String(existing.vendorName).trim() !== row.vendorName
          ) {
            updated += 1;
            await tx.vendorDirectoryEntry.update({
              where: { vendorCode: row.vendorCode },
              data: {
                supervisorCode: row.supervisorCode,
                vendorName: row.vendorName
              }
            });
          }
        }

        const removedRecords = existingRecords.filter((item) => !incomingVendorCodes.has(item.vendorCode));
        if (removedRecords.length) {
          await tx.vendorDirectoryEntry.deleteMany({
            where: {
              vendorCode: {
                in: removedRecords.map((item) => item.vendorCode)
              }
            }
          });
        }

        await recordAudit(
          {
            actor: authUser,
            action: "VENDOR_DIRECTORY_IMPORT",
            entityType: "VENDOR_DIRECTORY",
            entityId: "global",
            summary: `Base global de vendedores importada com ${rows.length} registro(s).`,
            before: {
              total: existingRecords.length
            },
            after: {
              total: rows.length,
              created,
              updated,
              removed: existingRecords.filter((item) => !incomingVendorCodes.has(item.vendorCode)).length,
              originalFileName: part.filename
            }
          },
          tx
        );
      });

      return {
        message: "Base global de vendedores importada com sucesso.",
        summary: {
          total: rows.length,
          created,
          updated,
          removed: existingRecords.filter((item) => !incomingVendorCodes.has(item.vendorCode)).length
        }
      };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Falha ao importar a base." });
    }
  });

  app.put("/api/vendor-directory/:vendorCode", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const parsed = updateVendorDirectorySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados invalidos para atualizar vendedor." });
    }

    const vendorCode = Number((request.params as { vendorCode: string }).vendorCode);
    if (!Number.isInteger(vendorCode) || vendorCode <= 0) {
      return reply.code(400).send({ message: "Codigo de vendedor invalido." });
    }

    const existing = await prisma.vendorDirectoryEntry.findUnique({
      where: { vendorCode }
    });

    if (!existing) {
      return reply.code(404).send({ message: "Vendedor nao encontrado na base geral." });
    }

    const vendorEmail = await prisma.meiVendorEmail.findUnique({
      where: { vendorCode }
    });

    const updated = await prisma.vendorDirectoryEntry.update({
      where: { vendorCode },
      data: {
        supervisorCode: parsed.data.supervisorCode,
        vendorName: parsed.data.vendorName
      }
    });

    await recordAudit({
      actor: authUser,
      action: "VENDOR_DIRECTORY_UPDATE",
      entityType: "VENDOR_DIRECTORY",
      entityId: vendorCode,
      summary: `Cadastro do vendedor ${existing.vendorName} foi atualizado manualmente.`,
      before: serializeVendorRecord(existing, vendorEmail?.email || ""),
      after: serializeVendorRecord(updated, vendorEmail?.email || "")
    });

    return {
      message: "Cadastro do vendedor atualizado com sucesso.",
      record: serializeVendorRecord(updated, vendorEmail?.email || "")
    };
  });

  app.delete("/api/vendor-directory/:vendorCode", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const vendorCode = Number((request.params as { vendorCode: string }).vendorCode);
    if (!Number.isInteger(vendorCode) || vendorCode <= 0) {
      return reply.code(400).send({ message: "Codigo de vendedor invalido." });
    }

    const existing = await prisma.vendorDirectoryEntry.findUnique({
      where: { vendorCode }
    });

    if (!existing) {
      return reply.code(404).send({ message: "Vendedor nao encontrado na base geral." });
    }

    const vendorEmail = await prisma.meiVendorEmail.findUnique({
      where: { vendorCode }
    });

    await prisma.$transaction(async (tx: any) => {
      if (vendorEmail) {
        await tx.meiVendorEmail.delete({
          where: { vendorCode }
        });
      }

      await tx.vendorDirectoryEntry.delete({
        where: { vendorCode }
      });

      await recordAudit(
        {
          actor: authUser,
          action: "VENDOR_DIRECTORY_DELETE",
          entityType: "VENDOR_DIRECTORY",
          entityId: vendorCode,
          summary: `Vendedor ${existing.vendorName} foi removido da base global.`,
          before: serializeVendorRecord(existing, vendorEmail?.email || ""),
          after: null
        },
        tx
      );
    });

    return {
      message: "Vendedor removido da base global com sucesso."
    };
  });
}
