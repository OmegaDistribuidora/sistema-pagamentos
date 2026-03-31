import type { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import { parseVendorDirectorySpreadsheet } from "../lib/vendorDirectoryExcel";
import {
  consumeVendorDirectoryPreviewSession,
  createVendorDirectoryPreviewSession
} from "../lib/vendorDirectoryPreviewStore";
import { requireAdmin, requireAuth } from "../lib/security";

const saveVendorEmailSchema = z.object({
  vendorCode: z.coerce.number().int().positive(),
  email: z.string().trim().email().or(z.literal(""))
});

const updateVendorDirectorySchema = z.object({
  supervisorCode: z.coerce.number().int().nonnegative(),
  vendorName: z.string().trim().min(1).max(255)
});

const createVendorDirectorySchema = z.object({
  supervisorCode: z.coerce.number().int().nonnegative(),
  vendorCode: z.coerce.number().int().positive(),
  vendorName: z.string().trim().min(1).max(255)
});

const confirmVendorDirectoryImportSchema = z.object({
  previewToken: z.string().min(1),
  mode: z.enum(["MERGE", "REPLACE"]).default("MERGE")
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

function buildVendorDirectoryDiff(existingRecords: any[], nextRows: Array<{ supervisorCode: number; vendorCode: number; vendorName: string }>) {
  const existingByVendorCode = new Map(existingRecords.map((record) => [record.vendorCode, record]));
  const seenVendorCodes = new Set<number>();
  const createdRows: typeof nextRows = [];
  const changedRows: Array<{ existingRecord: any; nextRow: (typeof nextRows)[number]; changedFields: string[] }> = [];
  const unchangedRows: typeof nextRows = [];

  for (const nextRow of nextRows) {
    const existing = existingByVendorCode.get(nextRow.vendorCode);
    if (!existing) {
      createdRows.push(nextRow);
      continue;
    }

    seenVendorCodes.add(nextRow.vendorCode);
    const changedFields: string[] = [];
    if (existing.supervisorCode !== nextRow.supervisorCode) {
      changedFields.push("supervisorCode");
    }
    if (String(existing.vendorName).trim() !== nextRow.vendorName) {
      changedFields.push("vendorName");
    }

    if (changedFields.length) {
      changedRows.push({
        existingRecord: existing,
        nextRow,
        changedFields
      });
    } else {
      unchangedRows.push(nextRow);
    }
  }

  const removedRecords = existingRecords.filter((record) => !seenVendorCodes.has(record.vendorCode));

  return {
    summary: {
      created: createdRows.length,
      updated: changedRows.length,
      removed: removedRecords.length,
      unchanged: unchangedRows.length,
      totalIncoming: nextRows.length,
      totalExisting: existingRecords.length
    },
    createdRows,
    changedRows,
    removedRecords,
    unchangedRows
  };
}

function buildVendorDirectoryChangePreview(diff: ReturnType<typeof buildVendorDirectoryDiff>) {
  return [
    ...diff.changedRows.slice(0, 8).map((item) => ({
      type: "UPDATE",
      vendorCode: item.nextRow.vendorCode,
      vendorName: item.nextRow.vendorName,
      supervisorCode: item.nextRow.supervisorCode,
      fields: item.changedFields
    })),
    ...diff.createdRows.slice(0, 6).map((item) => ({
      type: "CREATE",
      vendorCode: item.vendorCode,
      vendorName: item.vendorName,
      supervisorCode: item.supervisorCode,
      fields: ["novo-registro"]
    })),
    ...diff.removedRecords.slice(0, 6).map((item) => ({
      type: "REMOVE",
      vendorCode: item.vendorCode,
      vendorName: item.vendorName,
      supervisorCode: item.supervisorCode,
      fields: ["fora-da-planilha"]
    }))
  ];
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

  app.post("/api/vendor-directory/import/preview", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    try {
      const part = await request.file();
      if (!part) {
        return reply.code(400).send({ message: "Arquivo .xlsx obrigatorio." });
      }

      if (!String(part.filename || "").toLowerCase().endsWith(".xlsx")) {
        return reply.code(400).send({ message: "A base global deve ser enviada em arquivo .xlsx." });
      }

      const buffer = await part.toBuffer();
      const rows = parseVendorDirectorySpreadsheet(buffer);
      const existingRecords = await prisma.vendorDirectoryEntry.findMany();
      const diff = buildVendorDirectoryDiff(existingRecords, rows);
      const session = createVendorDirectoryPreviewSession({
        originalFileName: part.filename,
        rows
      });

      return {
        previewToken: session.token,
        originalFileName: part.filename,
        summary: {
          total: rows.length,
          created: diff.summary.created,
          updated: diff.summary.updated,
          removed: diff.summary.removed,
          unchanged: diff.summary.unchanged,
          totalExisting: diff.summary.totalExisting
        },
        previewRows: rows.slice(0, 12),
        changesPreview: buildVendorDirectoryChangePreview(diff)
      };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Falha ao importar a base." });
    }
  });

  app.post("/api/vendor-directory/import/confirm", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const parsed = confirmVendorDirectoryImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados da importacao invalidos." });
    }

    const previewSession = consumeVendorDirectoryPreviewSession(parsed.data.previewToken);
    if (!previewSession) {
      return reply.code(400).send({ message: "Preview expirado ou invalido. Reenvie a planilha." });
    }

    const existingRecords = await prisma.vendorDirectoryEntry.findMany();
    const diff = buildVendorDirectoryDiff(existingRecords, previewSession.rows);
    const modeLabel = parsed.data.mode === "REPLACE" ? "substituicao completa" : "mesclagem";

    await prisma.$transaction(async (tx: any) => {
      for (const row of diff.createdRows) {
        await tx.vendorDirectoryEntry.create({ data: row });
      }

      for (const item of diff.changedRows) {
        await tx.vendorDirectoryEntry.update({
          where: { vendorCode: item.nextRow.vendorCode },
          data: {
            supervisorCode: item.nextRow.supervisorCode,
            vendorName: item.nextRow.vendorName
          }
        });
      }

      if (parsed.data.mode === "REPLACE" && diff.removedRecords.length) {
        await tx.meiVendorEmail.deleteMany({
          where: {
            vendorCode: {
              in: diff.removedRecords.map((item) => item.vendorCode)
            }
          }
        });

        await tx.vendorDirectoryEntry.deleteMany({
          where: {
            vendorCode: {
              in: diff.removedRecords.map((item) => item.vendorCode)
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
          summary: `Base global de vendedores importada em modo ${modeLabel}.`,
          before: {
            total: existingRecords.length
          },
          after: {
            total: previewSession.rows.length,
            mode: parsed.data.mode,
            created: diff.summary.created,
            updated: diff.summary.updated,
            removed: parsed.data.mode === "REPLACE" ? diff.summary.removed : 0,
            unchanged: diff.summary.unchanged,
            originalFileName: previewSession.originalFileName
          }
        },
        tx
      );
    });

    return {
      message:
        parsed.data.mode === "REPLACE"
          ? "Base global substituida com sucesso."
          : "Base global mesclada com sucesso.",
      summary: {
        total: previewSession.rows.length,
        created: diff.summary.created,
        updated: diff.summary.updated,
        removed: parsed.data.mode === "REPLACE" ? diff.summary.removed : 0,
        unchanged: diff.summary.unchanged,
        mode: parsed.data.mode
      }
    };
  });

  app.post("/api/vendor-directory", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const parsed = createVendorDirectorySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados invalidos para criar vendedor." });
    }

    const existing = await prisma.vendorDirectoryEntry.findUnique({
      where: { vendorCode: parsed.data.vendorCode }
    });

    if (existing) {
      return reply.code(400).send({ message: "Ja existe um vendedor com esse codigo na base global." });
    }

    const created = await prisma.vendorDirectoryEntry.create({
      data: {
        supervisorCode: parsed.data.supervisorCode,
        vendorCode: parsed.data.vendorCode,
        vendorName: parsed.data.vendorName
      }
    });

    await recordAudit({
      actor: authUser,
      action: "VENDOR_DIRECTORY_CREATE",
      entityType: "VENDOR_DIRECTORY",
      entityId: created.vendorCode,
      summary: `Vendedor ${created.vendorName} foi adicionado manualmente a base global.`,
      before: null,
      after: serializeVendorRecord(created, "")
    });

    return {
      message: "Vendedor adicionado a base global com sucesso.",
      record: serializeVendorRecord(created, "")
    };
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
