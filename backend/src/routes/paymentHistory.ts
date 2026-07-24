import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import { decimalToNumber } from "../lib/serialize";
import {
  buildPaymentHistoryExport,
  buildPaymentHistoryKey,
  buildPaymentHistoryTemplate,
  parsePaymentHistoryWorkbook,
  PAYMENT_HISTORY_EVENTS,
  PAYMENT_HISTORY_METHODS,
  PAYMENT_HISTORY_MONTHS,
  PaymentHistoryImportError,
  validatePaymentHistoryInput,
  type PaymentHistoryInput
} from "../lib/paymentHistoryExcel";
import {
  createPaymentHistoryPreview,
  consumePaymentHistoryPreview
} from "../lib/paymentHistoryPreviewStore";
import {
  requireAuth,
  requirePaymentHistoryAccess,
  requirePaymentHistoryWriteAccess
} from "../lib/security";
import { getEffectiveSupervisorCodes } from "../lib/userSupervisorCodes";

type PaymentHistoryQuery = {
  search?: string;
  coordinatorCode?: string;
  region?: string;
  supervisorCode?: string;
  personType?: string;
  month?: string;
  year?: string;
  event?: string;
  paymentMethod?: string;
  supplier?: string;
};

function serializeRecord(record: any) {
  return {
    id: record.id,
    coordinatorCode: record.coordinatorCode,
    region: record.region,
    supervisorCode: record.supervisorCode,
    supervisorName: record.supervisorName,
    personCode: record.personCode,
    personName: record.personName,
    personType: record.personType,
    delinquencyAmount: decimalToNumber(record.delinquencyAmount),
    meiDiscountAmount: decimalToNumber(record.meiDiscountAmount),
    totalAmount: decimalToNumber(record.totalAmount),
    amountToPay: decimalToNumber(record.amountToPay),
    month: record.month,
    monthLabel: PAYMENT_HISTORY_MONTHS[record.month - 1] || String(record.month),
    year: record.year,
    event: record.event,
    supplier: record.supplier,
    paymentMethod: record.paymentMethod,
    releaseBy: record.releaseBy,
    sourceUser: record.sourceUser,
    registeredAt: record.registeredAt.toISOString().slice(0, 10),
    paidAt: record.paidAt.toISOString().slice(0, 10),
    competenceAt: record.competenceAt.toISOString().slice(0, 10),
    notes: record.notes,
    origin: record.origin,
    sourceFileName: record.sourceFileName,
    createdByUsername: record.createdByUsername,
    updatedByUsername: record.updatedByUsername,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function getActiveUser(userId: number) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      supervisorCode: true,
      supervisorCodes: true,
      canViewPaymentHistory: true,
      active: true
    }
  });
}

function getScopeWhere(user: any): any {
  if (user.role === "ADMIN" || user.role === "ANALYST") return {};
  return {
    supervisorCode: {
      in: getEffectiveSupervisorCodes(user)
    }
  };
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (!String(value || "").trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function buildRecordsWhere(query: PaymentHistoryQuery, user: any): any {
  const and: any[] = [getScopeWhere(user)];
  const coordinatorCode = parseOptionalInteger(query.coordinatorCode);
  const supervisorCode = parseOptionalInteger(query.supervisorCode);
  const month = parseOptionalInteger(query.month);
  const year = parseOptionalInteger(query.year);

  if (coordinatorCode != null) and.push({ coordinatorCode });
  if (supervisorCode != null) and.push({ supervisorCode });
  if (month != null) and.push({ month });
  if (year != null) and.push({ year });
  if (query.region) and.push({ region: query.region });
  if (query.personType) and.push({ personType: query.personType });
  if (query.event) and.push({ event: query.event });
  if (query.paymentMethod) and.push({ paymentMethod: query.paymentMethod });
  if (query.supplier) and.push({ supplier: query.supplier });

  const search = String(query.search || "").trim();
  if (search) {
    const numericSearch = Number(search);
    and.push({
      OR: [
        { personName: { contains: search, mode: "insensitive" } },
        { supervisorName: { contains: search, mode: "insensitive" } },
        { supplier: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
        { sourceUser: { contains: search, mode: "insensitive" } },
        ...(Number.isInteger(numericSearch)
          ? [{ personCode: numericSearch }, { supervisorCode: numericSearch }, { coordinatorCode: numericSearch }]
          : [])
      ]
    });
  }

  return { AND: and };
}

function buildFilterOptions(records: any[]) {
  const unique = (field: string, numeric = false) =>
    Array.from(new Set(records.map((record) => record[field]).filter((value) => value != null && String(value).trim())))
      .sort((left: any, right: any) =>
        numeric ? Number(left) - Number(right) : String(left).localeCompare(String(right), "pt-BR")
      );

  return {
    coordinatorCodes: unique("coordinatorCode", true),
    regions: unique("region"),
    supervisorCodes: unique("supervisorCode", true),
    personTypes: unique("personType"),
    months: unique("month", true),
    years: unique("year", true).reverse(),
    events: unique("event"),
    paymentMethods: unique("paymentMethod"),
    suppliers: unique("supplier")
  };
}

function toDatabaseData(
  input: PaymentHistoryInput,
  details: {
    origin: "MANUAL" | "IMPORT";
    username: string;
    sourceFileName?: string | null;
    update?: boolean;
  }
) {
  return {
    ...input,
    origin: details.origin,
    sourceFileName: details.sourceFileName || null,
    ...(details.update
      ? { updatedByUsername: details.username }
      : { createdByUsername: details.username, updatedByUsername: details.username })
  };
}

async function readUploadedFile(request: FastifyRequest): Promise<{ buffer: Buffer; fileName: string }> {
  const part = await (request as any).file();
  if (!part) throw new Error("Selecione uma planilha para importar.");
  return {
    buffer: await part.toBuffer(),
    fileName: String(part.filename || "historico-pagamentos.xlsx")
  };
}

async function findConflicts(input: PaymentHistoryInput, excludeId?: number) {
  const key = buildPaymentHistoryKey(input);
  if (!key) return [];
  return prisma.paymentHistoryRecord.findMany({
    where: {
      event: input.event,
      personCode: input.personCode,
      month: input.month,
      year: input.year,
      ...(excludeId ? { id: { not: excludeId } } : {})
    },
    orderBy: { id: "desc" }
  });
}

function conflictPayload(conflicts: any[]) {
  return conflicts.map((record) => ({
    id: record.id,
    personCode: record.personCode,
    personName: record.personName,
    event: record.event,
    month: record.month,
    monthLabel: PAYMENT_HISTORY_MONTHS[record.month - 1],
    year: record.year,
    supplier: record.supplier,
    totalAmount: decimalToNumber(record.totalAmount)
  }));
}

function sendWorkbook(reply: FastifyReply, buffer: Buffer, fileName: string) {
  return reply
    .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .header("Content-Disposition", `attachment; filename="${fileName}"`)
    .send(buffer);
}

export async function registerPaymentHistoryRoutes(app: FastifyInstance): Promise<void> {
  const readGuards = [requireAuth, requirePaymentHistoryAccess];
  const writeGuards = [requireAuth, requirePaymentHistoryAccess, requirePaymentHistoryWriteAccess];

  app.get("/api/modules/payment-history", { preHandler: readGuards }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuario nao autenticado." });
    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuario nao encontrado." });

    const query = (request.query || {}) as PaymentHistoryQuery;
    const [records, optionRecords] = await Promise.all([
      prisma.paymentHistoryRecord.findMany({
        where: buildRecordsWhere(query, user),
        orderBy: [{ year: "desc" }, { month: "desc" }, { registeredAt: "desc" }, { id: "desc" }]
      }),
      prisma.paymentHistoryRecord.findMany({
        where: getScopeWhere(user),
        select: {
          coordinatorCode: true,
          region: true,
          supervisorCode: true,
          personType: true,
          month: true,
          year: true,
          event: true,
          paymentMethod: true,
          supplier: true
        }
      })
    ]);

    return {
      records: records.map(serializeRecord),
      total: records.length,
      canManage: user.role === "ADMIN" || user.role === "ANALYST",
      events: PAYMENT_HISTORY_EVENTS,
      paymentMethods: PAYMENT_HISTORY_METHODS,
      months: PAYMENT_HISTORY_MONTHS,
      filterOptions: buildFilterOptions(optionRecords)
    };
  });

  app.get("/api/modules/payment-history/template", { preHandler: readGuards }, async (_request, reply) => {
    return sendWorkbook(reply, buildPaymentHistoryTemplate(), "modelo-historico-pagamentos.xlsx");
  });

  app.get("/api/modules/payment-history/export", { preHandler: readGuards }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuario nao autenticado." });
    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuario nao encontrado." });

    const records = await prisma.paymentHistoryRecord.findMany({
      where: buildRecordsWhere((request.query || {}) as PaymentHistoryQuery, user),
      orderBy: [{ year: "desc" }, { month: "desc" }, { registeredAt: "desc" }, { id: "desc" }]
    });

    await recordAudit({
      actor: authUser,
      action: "PAYMENT_HISTORY_EXPORT",
      entityType: "PAYMENT_HISTORY",
      summary: `${authUser.username} exportou ${records.length} registros visíveis do Histórico de Pagamentos.`,
      metadata: { count: records.length, filters: request.query || {} }
    });

    return sendWorkbook(
      reply,
      buildPaymentHistoryExport(records),
      `historico-pagamentos-${new Date().toISOString().slice(0, 10)}.xlsx`
    );
  });

  app.post("/api/modules/payment-history/records", { preHandler: writeGuards }, async (request, reply) => {
    const authUser = request.authUser!;
    let input: PaymentHistoryInput;
    try {
      input = validatePaymentHistoryInput((request.body as any)?.record ?? request.body);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Dados inválidos." });
    }

    const confirmConflict = (request.body as any)?.confirmConflict === true;
    const conflicts = await findConflicts(input);
    if (conflicts.length && !confirmConflict) {
      return reply.code(409).send({
        message: `Já existe ${conflicts.length === 1 ? "um registro" : `${conflicts.length} registros`} para o mesmo evento, código e período. Confirmando, o registro mais recente será alterado.`,
        conflict: true,
        conflicts: conflictPayload(conflicts)
      });
    }

    const result = await prisma.$transaction(async (tx: any) => {
      if (conflicts.length) {
        const before = serializeRecord(conflicts[0]);
        const updated = await tx.paymentHistoryRecord.update({
          where: { id: conflicts[0].id },
          data: toDatabaseData(input, { origin: "MANUAL", username: authUser.username, update: true })
        });
        await recordAudit(
          {
            actor: authUser,
            action: "PAYMENT_HISTORY_UPDATE_CONFLICT",
            entityType: "PAYMENT_HISTORY_RECORD",
            entityId: updated.id,
            summary: `${authUser.username} alterou um registro existente do Histórico de Pagamentos após confirmar conflito.`,
            before,
            after: serializeRecord(updated),
            metadata: { legacyConflictCount: conflicts.length }
          },
          tx
        );
        return { record: updated, operation: "updated" };
      }

      const created = await tx.paymentHistoryRecord.create({
        data: toDatabaseData(input, { origin: "MANUAL", username: authUser.username })
      });
      await recordAudit(
        {
          actor: authUser,
          action: "PAYMENT_HISTORY_CREATE",
          entityType: "PAYMENT_HISTORY_RECORD",
          entityId: created.id,
          summary: `${authUser.username} adicionou um registro ao Histórico de Pagamentos.`,
          before: null,
          after: serializeRecord(created)
        },
        tx
      );
      return { record: created, operation: "created" };
    });

    return reply.code(result.operation === "created" ? 201 : 200).send({
      record: serializeRecord(result.record),
      operation: result.operation
    });
  });

  app.put("/api/modules/payment-history/records/:id", { preHandler: writeGuards }, async (request, reply) => {
    const authUser = request.authUser!;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ message: "Registro inválido." });

    const current = await prisma.paymentHistoryRecord.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ message: "Registro não encontrado." });

    let input: PaymentHistoryInput;
    try {
      input = validatePaymentHistoryInput((request.body as any)?.record ?? request.body);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Dados inválidos." });
    }

    const conflicts = await findConflicts(input, id);
    if (conflicts.length && (request.body as any)?.confirmConflict !== true) {
      return reply.code(409).send({
        message: "A alteração passa a coincidir com outro registro do mesmo evento, código e período. Confirme para continuar.",
        conflict: true,
        conflicts: conflictPayload(conflicts)
      });
    }

    const updated = await prisma.$transaction(async (tx: any) => {
      const record = await tx.paymentHistoryRecord.update({
        where: { id },
        data: toDatabaseData(input, { origin: "MANUAL", username: authUser.username, update: true })
      });
      await recordAudit(
        {
          actor: authUser,
          action: "PAYMENT_HISTORY_UPDATE",
          entityType: "PAYMENT_HISTORY_RECORD",
          entityId: id,
          summary: `${authUser.username} editou um registro do Histórico de Pagamentos.`,
          before: serializeRecord(current),
          after: serializeRecord(record),
          metadata: conflicts.length ? { confirmedConflictCount: conflicts.length } : undefined
        },
        tx
      );
      return record;
    });

    return { record: serializeRecord(updated), operation: "updated" };
  });

  app.delete("/api/modules/payment-history/records/:id", { preHandler: writeGuards }, async (request, reply) => {
    const authUser = request.authUser!;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ message: "Registro inválido." });
    const current = await prisma.paymentHistoryRecord.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ message: "Registro não encontrado." });

    await prisma.$transaction(async (tx: any) => {
      await tx.paymentHistoryRecord.delete({ where: { id } });
      await recordAudit(
        {
          actor: authUser,
          action: "PAYMENT_HISTORY_DELETE",
          entityType: "PAYMENT_HISTORY_RECORD",
          entityId: id,
          summary: `${authUser.username} removeu um registro do Histórico de Pagamentos.`,
          before: serializeRecord(current),
          after: null
        },
        tx
      );
    });
    return reply.code(204).send();
  });

  app.post("/api/modules/payment-history/import/preview", { preHandler: writeGuards }, async (request, reply) => {
    const authUser = request.authUser!;
    let upload: { buffer: Buffer; fileName: string };
    let rows: PaymentHistoryInput[];
    try {
      upload = await readUploadedFile(request);
      rows = parsePaymentHistoryWorkbook(upload.buffer);
    } catch (error) {
      if (error instanceof PaymentHistoryImportError) {
        return reply.code(400).send({
          message: `A planilha possui ${error.issues.length} erro(s).`,
          issues: error.issues
        });
      }
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Falha ao ler a planilha." });
    }

    const existing = await prisma.paymentHistoryRecord.findMany({
      orderBy: { id: "desc" },
      select: {
        id: true,
        event: true,
        personCode: true,
        personName: true,
        month: true,
        year: true
      }
    });
    const existingByKey = new Map<string, any[]>();
    for (const record of existing) {
      const key = buildPaymentHistoryKey(record as any);
      if (!key) continue;
      existingByKey.set(key, [...(existingByKey.get(key) || []), record]);
    }

    const finalByKey = new Map<string, PaymentHistoryInput>();
    const considerations: PaymentHistoryInput[] = [];
    let duplicateUploadCount = 0;
    for (const row of rows) {
      const key = buildPaymentHistoryKey(row);
      if (!key) {
        considerations.push(row);
        continue;
      }
      if (finalByKey.has(key)) duplicateUploadCount += 1;
      finalByKey.set(key, row);
    }

    const keyedRows = Array.from(finalByKey.entries());
    const conflicts = keyedRows
      .filter(([key]) => existingByKey.has(key))
      .map(([key, row]) => {
        const records = existingByKey.get(key)!;
        return {
          id: records[0].id,
          personCode: row.personCode,
          personName: row.personName,
          event: row.event,
          month: row.month,
          year: row.year,
          existingCount: records.length
        };
      });
    const finalRows = [...keyedRows.map(([, row]) => row), ...considerations];
    const token = createPaymentHistoryPreview({
      userId: authUser.userId,
      originalFileName: upload.fileName,
      rows,
      finalRows,
      createdCount: keyedRows.filter(([key]) => !existingByKey.has(key)).length + considerations.length,
      updatedCount: conflicts.length,
      considerationCount: considerations.length,
      duplicateUploadCount,
      conflicts
    });

    return {
      token,
      fileName: upload.fileName,
      totalRows: rows.length,
      effectiveRows: finalRows.length,
      createdCount: keyedRows.filter(([key]) => !existingByKey.has(key)).length + considerations.length,
      updatedCount: conflicts.length,
      considerationCount: considerations.length,
      duplicateUploadCount,
      conflicts: conflicts.slice(0, 100),
      sample: finalRows.slice(0, 20).map((row) => ({
        personCode: row.personCode,
        personName: row.personName,
        event: row.event,
        month: row.month,
        monthLabel: PAYMENT_HISTORY_MONTHS[row.month - 1],
        year: row.year,
        totalAmount: row.totalAmount
      }))
    };
  });

  app.post("/api/modules/payment-history/import/confirm", { preHandler: writeGuards }, async (request, reply) => {
    const authUser = request.authUser!;
    const token = String((request.body as any)?.token || "");
    const preview = consumePaymentHistoryPreview(token, authUser.userId);
    if (!preview) {
      return reply.code(404).send({ message: "Prévia expirada ou inválida. Faça o upload novamente." });
    }

    const result = await prisma.$transaction(async (tx: any) => {
      const existing = await tx.paymentHistoryRecord.findMany({
        orderBy: { id: "desc" },
        select: { id: true, event: true, personCode: true, month: true, year: true }
      });
      const existingByKey = new Map<string, number>();
      for (const record of existing) {
        const key = buildPaymentHistoryKey(record as any);
        if (key && !existingByKey.has(key)) existingByKey.set(key, record.id);
      }

      let createdCount = 0;
      let updatedCount = 0;
      for (const row of preview.finalRows) {
        const key = buildPaymentHistoryKey(row);
        const targetId = key ? existingByKey.get(key) : null;
        if (targetId) {
          await tx.paymentHistoryRecord.update({
            where: { id: targetId },
            data: toDatabaseData(row, {
              origin: "IMPORT",
              username: authUser.username,
              sourceFileName: preview.originalFileName,
              update: true
            })
          });
          updatedCount += 1;
        } else {
          const created = await tx.paymentHistoryRecord.create({
            data: toDatabaseData(row, {
              origin: "IMPORT",
              username: authUser.username,
              sourceFileName: preview.originalFileName
            })
          });
          if (key) existingByKey.set(key, created.id);
          createdCount += 1;
        }
      }

      await recordAudit(
        {
          actor: authUser,
          action: "PAYMENT_HISTORY_IMPORT",
          entityType: "PAYMENT_HISTORY",
          summary: `${authUser.username} importou ${preview.originalFileName} no Histórico de Pagamentos.`,
          before: null,
          after: {
            fileName: preview.originalFileName,
            receivedRows: preview.rows.length,
            effectiveRows: preview.finalRows.length,
            createdCount,
            updatedCount
          },
          metadata: {
            duplicateUploadCount: preview.duplicateUploadCount,
            conflictCount: preview.conflicts.length
          }
        },
        tx
      );
      return { createdCount, updatedCount };
    });

    return {
      message: "Importação concluída com sucesso.",
      ...result
    };
  });
}
