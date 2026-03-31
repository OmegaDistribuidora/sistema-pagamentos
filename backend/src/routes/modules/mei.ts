import { PassThrough } from "node:stream";
import archiver from "archiver";
import PDFDocument from "pdfkit";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { recordAudit } from "../../lib/audit";
import { createPreviewSession, consumePreviewSession } from "../../lib/meiImportPreviewStore";
import { parseMeiSpreadsheet } from "../../lib/meiExcel";
import { getEmailProviderName, isEmailDeliveryConfigured, sendTransactionalEmail } from "../../lib/email";
import {
  formatBrazilDate,
  formatBrazilTime,
  formatReferenceMonth,
  formatStoredDateRange,
  getPreviousReferenceMonth,
  getReferenceMonthDateRange,
  normalizeStoredDate,
  parseReferenceMonth
} from "../../lib/dates";
import { decimalToNumber } from "../../lib/serialize";
import { requireAdmin, requireAuth, requireSupervisor } from "../../lib/security";
import { readUpload, removeUpload, sanitizeFileName, saveBufferToUploads } from "../../lib/storage";

const confirmImportSchema = z.object({
  previewToken: z.string().min(1),
  referenceMonth: z.string().min(1),
  replaceExisting: z.boolean().default(false)
});

const rejectInvoiceSchema = z.object({
  reason: z.string().max(500).optional().or(z.literal(""))
});

const approveAllSchema = z.object({
  referenceMonth: z.string().min(1)
});

const sendAllExtractEmailsSchema = z.object({
  referenceMonth: z.string().min(1)
});

const updateEntrySchema = z.object({
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  supervisorCode: z.coerce.number().int().nonnegative(),
  vendorCode: z.coerce.number().int().nonnegative(),
  vendorName: z.string().trim().min(1).max(255),
  grossSales: z.coerce.number(),
  returnsAmount: z.coerce.number(),
  netSales: z.coerce.number(),
  advanceAmount: z.coerce.number(),
  delinquencyAmount: z.coerce.number(),
  grossCommission: z.coerce.number(),
  averageCommissionPercent: z.coerce.number(),
  reversalAmount: z.coerce.number(),
  totalCommissionToInvoice: z.coerce.number(),
  commissionToReceive: z.coerce.number()
});

const saveVendorEmailSchema = z.object({
  vendorCode: z.coerce.number().int().positive(),
  email: z.string().trim().email()
});

function numbersEqual(left: number, right: number): boolean {
  return Math.abs(Number(left || 0) - Number(right || 0)) < 0.000001;
}

function buildComparableEntry(entry: any) {
  return {
    periodStart: entry.periodStart ? String(entry.periodStart) : null,
    periodEnd: entry.periodEnd ? String(entry.periodEnd) : null,
    supervisorCode: Number(entry.supervisorCode),
    vendorCode: Number(entry.vendorCode),
    vendorName: String(entry.vendorName || "").trim(),
    grossSales: decimalToNumber(entry.grossSales),
    returnsAmount: decimalToNumber(entry.returnsAmount),
    netSales: decimalToNumber(entry.netSales),
    advanceAmount: decimalToNumber(entry.advanceAmount),
    delinquencyAmount: decimalToNumber(entry.delinquencyAmount),
    grossCommission: decimalToNumber(entry.grossCommission),
    averageCommissionPercent: decimalToNumber(entry.averageCommissionPercent),
    reversalAmount: decimalToNumber(entry.reversalAmount),
    totalCommissionToInvoice: decimalToNumber(entry.totalCommissionToInvoice),
    commissionToReceive: decimalToNumber(entry.commissionToReceive)
  };
}

function buildMeiBatchDiff(existingEntries: any[], nextRows: any[]) {
  const existingByVendorCode = new Map(existingEntries.map((entry) => [Number(entry.vendorCode), entry]));
  const seenVendorCodes = new Set<number>();
  const changedRows: Array<{ existingEntry: any; nextRow: any; changedFields: string[] }> = [];
  const createdRows: any[] = [];
  const unchangedRows: any[] = [];

  for (const nextRow of nextRows) {
    const existingEntry = existingByVendorCode.get(Number(nextRow.vendorCode));
    if (!existingEntry) {
      createdRows.push(nextRow);
      continue;
    }

    seenVendorCodes.add(Number(nextRow.vendorCode));
    const comparableExisting = buildComparableEntry(existingEntry);
    const comparableNext = buildComparableEntry(nextRow);
    const comparableKeys = Object.keys(comparableNext) as Array<keyof typeof comparableNext>;
    const changedFields = comparableKeys.filter((field) => {
      if (typeof comparableNext[field] === "number" && typeof comparableExisting[field] === "number") {
        return !numbersEqual(comparableExisting[field], comparableNext[field]);
      }
      return comparableExisting[field] !== comparableNext[field];
    });

    if (changedFields.length) {
      changedRows.push({
        existingEntry,
        nextRow,
        changedFields
      });
    } else {
      unchangedRows.push(nextRow);
    }
  }

  const removedEntries = existingEntries.filter((entry) => !seenVendorCodes.has(Number(entry.vendorCode)));

  return {
    summary: {
      changed: changedRows.length,
      created: createdRows.length,
      removed: removedEntries.length,
      unchanged: unchangedRows.length,
      totalIncoming: nextRows.length,
      totalExisting: existingEntries.length
    },
    changedRows,
    createdRows,
    removedEntries,
    unchangedRows
  };
}

function buildDiffPreview(diff: ReturnType<typeof buildMeiBatchDiff>) {
  return [
    ...diff.changedRows.slice(0, 8).map((item) => ({
      type: "UPDATE",
      vendorCode: item.nextRow.vendorCode,
      vendorName: item.nextRow.vendorName,
      fields: item.changedFields
    })),
    ...diff.createdRows.slice(0, 4).map((item) => ({
      type: "CREATE",
      vendorCode: item.vendorCode,
      vendorName: item.vendorName,
      fields: ["novo-registro"]
    })),
    ...diff.removedEntries.slice(0, 4).map((item) => ({
      type: "REMOVE",
      vendorCode: item.vendorCode,
      vendorName: item.vendorName,
      fields: ["removido-da-planilha"]
    }))
  ];
}

function serializeSubmission(submission: any) {
  if (!submission) {
    return null;
  }

  return {
    id: submission.id,
    status: submission.status,
    isCurrent: submission.isCurrent,
    originalFileName: submission.originalFileName,
    mimeType: submission.mimeType,
    sizeBytes: submission.sizeBytes,
    rejectionReason: submission.rejectionReason,
    submittedAt: submission.submittedAt,
    reviewedAt: submission.reviewedAt,
    uploadedBy: submission.uploadedByUser
      ? {
          id: submission.uploadedByUser.id,
          username: submission.uploadedByUser.username,
          displayName: submission.uploadedByUser.displayName
        }
      : null,
    reviewedBy: submission.reviewedByUser
      ? {
          id: submission.reviewedByUser.id,
          username: submission.reviewedByUser.username,
          displayName: submission.reviewedByUser.displayName
        }
      : null
  };
}

function serializeEntry(entry: any) {
  const currentSubmission = entry.submissions?.[0] || null;
  const fallbackRange = entry.batch?.referenceMonth ? getReferenceMonthDateRange(entry.batch.referenceMonth) : null;
  const periodStart = entry.periodStart || fallbackRange?.start || null;
  const periodEnd = entry.periodEnd || fallbackRange?.end || null;

  return {
    id: entry.id,
    batchId: entry.batchId,
    referenceMonth: entry.batch?.referenceMonth,
    periodStart,
    periodEnd,
    supervisorCode: entry.supervisorCode,
    vendorCode: entry.vendorCode,
    vendorName: entry.vendorName,
    grossSales: decimalToNumber(entry.grossSales),
    returnsAmount: decimalToNumber(entry.returnsAmount),
    netSales: decimalToNumber(entry.netSales),
    advanceAmount: decimalToNumber(entry.advanceAmount),
    delinquencyAmount: decimalToNumber(entry.delinquencyAmount),
    grossCommission: decimalToNumber(entry.grossCommission),
    averageCommissionPercent: decimalToNumber(entry.averageCommissionPercent),
    reversalAmount: decimalToNumber(entry.reversalAmount),
    totalCommissionToInvoice: decimalToNumber(entry.totalCommissionToInvoice),
    commissionToReceive: decimalToNumber(entry.commissionToReceive),
    invoiceStatus: currentSubmission?.status || "NOT_SENT",
    currentSubmission: serializeSubmission(currentSubmission)
  };
}

function buildImportSnapshot(referenceMonth: string, rows: any[]) {
  return {
    referenceMonth,
    totalRows: rows.length,
    supervisorCount: new Set(rows.map((row) => row.supervisorCode)).size,
    totalCommissionToReceive: rows.reduce((sum, row) => sum + Number(row.commissionToReceive || 0), 0)
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
      active: true
    }
  });
}

async function findAccessibleVendor(vendorCode: number, user: any) {
  return prisma.meiCommissionEntry.findFirst({
    where: {
      vendorCode,
      ...(user.role === "USER" ? { supervisorCode: user.supervisorCode } : {})
    },
    orderBy: {
      createdAt: "desc"
    },
    include: {
      batch: {
        select: {
          referenceMonth: true
        }
      }
    }
  });
}

async function readMultipartFile(request: any): Promise<{
  part: any;
  buffer: Buffer;
  fields: Record<string, any>;
}> {
  const part = await request.file();
  if (!part) {
    throw new Error("Arquivo obrigatorio.");
  }

  const buffer = await part.toBuffer();
  return {
    part,
    buffer,
    fields: part.fields || {}
  };
}

function validateNoDuplicateVendors(rows: Array<{ vendorCode: number }>): void {
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.vendorCode)) {
      throw new Error(`Codigo de vendedor duplicado na planilha: ${row.vendorCode}.`);
    }
    seen.add(row.vendorCode);
  }
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value || 0);
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  }).format(value || 0)}%`;
}

async function buildMeiExtractPdf(entry: any): Promise<Buffer> {
  return buildMeiExtractPdfWithContext(entry, "Sistema");
}

function normalizeDownloadNamePart(value: string): string {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-");

  return normalized || "Vendedor";
}

function buildExtractFileName(entry: any): string {
  return `Extrato-${entry.vendorCode}-${normalizeDownloadNamePart(entry.vendorName)}.pdf`;
}

function formatReferenceMonthSlash(referenceMonth: string): string {
  const [year, month] = String(referenceMonth || "").split("-").map(Number);
  if (!year || !month) {
    return String(referenceMonth || "");
  }
  return `${String(month).padStart(2, "0")}/${year}`;
}

function getEntryPeriodLabel(entry: any): string {
  const serialized = serializeEntry(entry);
  if (serialized.periodStart && serialized.periodEnd) {
    return formatStoredDateRange(serialized.periodStart, serialized.periodEnd);
  }

  return formatReferenceMonth(serialized.referenceMonth || "");
}

function buildMeiExtractEmailSubject(entry: any): string {
  return `Extrato MEI - Omega Distribuidora ${formatReferenceMonthSlash(entry.batch?.referenceMonth || "")}`;
}

function buildMeiExtractEmailContent() {
  const text = [
    "Bom dia prestador de serviço.",
    "Segue seu extrato MEI em PDF. Qualquer dúvida entrar em contato com seu supervisor.",
    "",
    "Este é um email automático. Não responda."
  ].join("\n");
  return {
    html: `
      <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
        <p>Bom dia prestador de serviço.</p>
        <p>Segue seu extrato MEI em PDF. Qualquer dúvida entrar em contato com seu supervisor.</p>
        <p>Este é um email automático. Não responda.</p>
      </div>
    `.trim(),
    text
  };
}

function buildMeiExtractEmailBatchPreview(entries: any[], vendorEmails: Array<{ vendorCode: number; email: string }>) {
  const emailByVendorCode = new Map(vendorEmails.map((item) => [Number(item.vendorCode), item.email]));
  const recipients: Array<{ entryId: number; vendorCode: number; vendorName: string; supervisorCode: number; email: string }> = [];
  const skipped: Array<{ entryId: number; vendorCode: number; vendorName: string; supervisorCode: number; reason: string }> = [];

  for (const entry of entries) {
    const email = String(emailByVendorCode.get(Number(entry.vendorCode)) || "").trim();
    if (email) {
      recipients.push({
        entryId: entry.id,
        vendorCode: entry.vendorCode,
        vendorName: entry.vendorName,
        supervisorCode: entry.supervisorCode,
        email
      });
      continue;
    }

    skipped.push({
      entryId: entry.id,
      vendorCode: entry.vendorCode,
      vendorName: entry.vendorName,
      supervisorCode: entry.supervisorCode,
      reason: "Sem email cadastrado"
    });
  }

  return {
    recipients,
    skipped,
    summary: {
      totalEntries: entries.length,
      willSend: recipients.length,
      skipped: skipped.length
    }
  };
}

async function buildMeiExtractPdfWithContext(entry: any, downloadedByName: string): Promise<Buffer> {
  const serialized = serializeEntry(entry);
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const contentX = 24;
    const contentWidth = pageWidth - contentX * 2;
    const labelColor = "#6f6177";
    const headerColor = "#203d5a";
    const borderColor = "#4e4e4e";
    const boxHeight = 30;

    const drawField = (label: string, value: string, x: number, y: number, width: number) => {
      doc.font("Helvetica-Bold").fontSize(10.2).fillColor(labelColor).text(label, x, y);
      const boxY = y + 20;
      doc
        .lineWidth(0.8)
        .undash()
        .rect(x, boxY, width, boxHeight)
        .strokeColor(borderColor)
        .stroke();

      doc
        .font("Helvetica-Bold")
        .fontSize(10.2)
        .fillColor("#222222")
        .text(value, x + 8, boxY + 10, {
          width: width - 16,
          lineBreak: false
        });
    };

    doc.rect(0, 0, pageWidth, 60).fill(headerColor);
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#f4f7fb").text("EXTRATO MEI", contentX, 18);

    drawField(
      "Per\u00edodo",
      serialized.periodStart && serialized.periodEnd
        ? formatStoredDateRange(serialized.periodStart, serialized.periodEnd)
        : formatReferenceMonth(serialized.referenceMonth || ""),
      contentX,
      78,
      278
    );
    drawField("C\u00f3digo", String(serialized.vendorCode), contentX, 156, 122);
    drawField("Prestador de servi\u00e7o", serialized.vendorName, contentX + 155, 156, 370);

    drawField("Vlr. Venda bruta", formatMoney(serialized.grossSales), contentX, 234, 198);
    drawField("Comiss\u00e3o Bruta", formatMoney(serialized.grossCommission), contentX + 250, 234, 184);
    drawField("% Com. m\u00e9dia", formatPercent(serialized.averageCommissionPercent), contentX + 440, 234, 105);

    drawField("Vlr. Devolu\u00e7\u00e3o", formatMoney(serialized.returnsAmount), contentX, 295, 198);
    drawField("Vlr. Estorno Devolu\u00e7\u00e3o", formatMoney(serialized.reversalAmount), contentX + 250, 295, 198);

    drawField("Vlr. Venda L\u00edquida", formatMoney(serialized.netSales), contentX, 356, 198);
    drawField("Total comiss\u00e3o m\u00eas a faturar", formatMoney(serialized.totalCommissionToInvoice), contentX + 250, 356, 238);

    drawField("Adiantamento", formatMoney(serialized.advanceAmount), contentX, 417, 198);
    drawField("Saldo de comiss\u00e3o a receber", formatMoney(serialized.commissionToReceive), contentX + 250, 417, 238);

    doc
      .dash(3, { space: 2 })
      .moveTo(contentX, 491)
      .lineTo(pageWidth - contentX, 491)
      .strokeColor("#111111")
      .lineWidth(1.4)
      .stroke()
      .undash();

    drawField("Inadimpl\u00eancia", formatMoney(serialized.delinquencyAmount), contentX, 504, 198);

    const paragraphOptions = {
      width: contentWidth,
      lineGap: 1
    };

    doc.font("Helvetica").fontSize(9.7).fillColor("#222222");
    doc.text("Prezado parceiro comercial,", contentX, 573, paragraphOptions);
    doc.text("Segue o extrato de comiss\u00f5es referente ao per\u00edodo informado.", contentX, doc.y + 8, paragraphOptions);
    doc.text(
      "Solicitamos, por gentileza, a emiss\u00e3o da Nota Fiscal de Servi\u00e7os correspondente, para que possamos providenciar o pagamento.",
      contentX,
      doc.y + 2,
      paragraphOptions
    );
    doc.text(
      "Aproveitamos para solicitar sua aten\u00e7\u00e3o ao valor de inadimpl\u00eancia da sua carteira de clientes, que tamb\u00e9m consta no extrato.",
      contentX,
      doc.y + 2,
      paragraphOptions
    );
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").text("Per\u00edodo de pagamento:", contentX, doc.y, paragraphOptions);
    doc.font("Helvetica").text("- Encaminhar a nota para o seu supervisor.", contentX, doc.y + 6, paragraphOptions);
    doc.text(
      "- Notas fiscais recebidas at\u00e9 o 4\u00b0 dia \u00fatil do m\u00eas, ser\u00e3o pagas at\u00e9 o 6\u00b0 dia \u00fatil.",
      contentX,
      doc.y + 2,
      paragraphOptions
    );
    doc.text(
      "- Notas fiscais recebidas ap\u00f3s o 4\u00b0 dia \u00fatil do m\u00eas ser\u00e3o pagas no d\u00e9cimo dia \u00fatil.",
      contentX,
      doc.y + 2,
      paragraphOptions
    );
    doc.moveDown(0.8);
    doc.text("Atenciosamente,", contentX, doc.y, paragraphOptions);
    doc.text("Equipe Comercial \u00d4mega Distribuidora.", contentX, doc.y + 2, paragraphOptions);
    doc.moveDown(0.9);
    doc
      .fontSize(10)
      .fillColor("#555555")
      .text(
        `Documento gerado pelo Sistema de Pagamentos no dia ${formatBrazilDate()} \u00e0s ${formatBrazilTime()} pelo usuario ${downloadedByName}.`,
        contentX,
        doc.y,
        paragraphOptions
      );
    doc.end();
  });
}

function ensureEntryAccess(entry: any, user: any): boolean {
  if (user.role === "ADMIN") {
    return true;
  }

  return Boolean(user.supervisorCode) && entry.supervisorCode === user.supervisorCode;
}

export async function registerMeiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/modules/mei/months", { preHandler: [requireAuth] }, async () => {
    const batches = await prisma.meiImportBatch.findMany({
      orderBy: { referenceMonth: "desc" },
      select: {
        referenceMonth: true
      }
    });

    return {
      months: batches.map((batch) => batch.referenceMonth),
      defaultMonth: getPreviousReferenceMonth()
    };
  });

  app.get("/api/modules/mei/overview", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const query = (request.query as { referenceMonth?: string }) || {};
    const referenceMonth = parseReferenceMonth(query.referenceMonth || getPreviousReferenceMonth());

    const batch = await prisma.meiImportBatch.findUnique({
      where: { referenceMonth },
      select: {
        id: true,
        referenceMonth: true,
        originalFileName: true,
        totalRows: true,
        createdAt: true
      }
    });

    if (!batch) {
      return {
        referenceMonth,
        hasBatch: false,
        batch: null,
        entries: [],
        summary: {
          totalVendors: 0,
          totalCommissionToReceive: 0,
          pendingInvoices: 0,
          approvedInvoices: 0,
          rejectedInvoices: 0,
          notSentInvoices: 0
        }
      };
    }

    if (user.role === "USER" && !user.supervisorCode) {
      return reply.code(400).send({ message: "Usuario supervisor sem codigo de supervisor configurado." });
    }

    const entries = await prisma.meiCommissionEntry.findMany({
      where: {
        batchId: batch.id,
        ...(user.role === "USER" ? { supervisorCode: user.supervisorCode! } : {})
      },
      include: {
        batch: {
          select: {
            referenceMonth: true
          }
        },
        submissions: {
          where: {
            isCurrent: true
          },
          orderBy: {
            createdAt: "desc"
          },
          take: 1,
          include: {
            uploadedByUser: {
              select: {
                id: true,
                username: true,
                displayName: true
              }
            },
            reviewedByUser: {
              select: {
                id: true,
                username: true,
                displayName: true
              }
            }
          }
        }
      },
      orderBy: [{ supervisorCode: "asc" }, { vendorName: "asc" }]
    });

    const serializedEntries = entries.map(serializeEntry);
    const summary = serializedEntries.reduce(
      (accumulator, entry) => {
        accumulator.totalVendors += 1;
        accumulator.totalCommissionToReceive += entry.commissionToReceive;
        if (entry.invoiceStatus === "PENDING") accumulator.pendingInvoices += 1;
        if (entry.invoiceStatus === "APPROVED") accumulator.approvedInvoices += 1;
        if (entry.invoiceStatus === "REJECTED") accumulator.rejectedInvoices += 1;
        if (entry.invoiceStatus === "NOT_SENT") accumulator.notSentInvoices += 1;
        return accumulator;
      },
      {
        totalVendors: 0,
        totalCommissionToReceive: 0,
        pendingInvoices: 0,
        approvedInvoices: 0,
        rejectedInvoices: 0,
        notSentInvoices: 0
      }
    );

    return {
      referenceMonth,
      hasBatch: true,
      batch,
      entries: serializedEntries,
      summary
    };
  });

  app.get("/api/modules/mei/email-base", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    if (user.role === "USER" && !user.supervisorCode) {
      return reply.code(400).send({ message: "Supervisor sem codigo configurado." });
    }

    const recentEntries = await prisma.meiCommissionEntry.findMany({
      where: user.role === "USER" ? { supervisorCode: user.supervisorCode! } : undefined,
      orderBy: [{ createdAt: "desc" }, { vendorCode: "asc" }],
      include: {
        batch: {
          select: {
            referenceMonth: true
          }
        }
      }
    });

    const latestVendorEntries = new Map<number, any>();
    recentEntries.forEach((entry) => {
      if (!latestVendorEntries.has(entry.vendorCode)) {
        latestVendorEntries.set(entry.vendorCode, entry);
      }
    });

    const vendorCodes = Array.from(latestVendorEntries.keys());
    const vendorEmails = vendorCodes.length
      ? await prisma.meiVendorEmail.findMany({
          where: {
            vendorCode: {
              in: vendorCodes
            }
          },
          orderBy: {
            vendorCode: "asc"
          }
        })
      : [];

    const emailByVendorCode = new Map(vendorEmails.map((item) => [item.vendorCode, item]));
    const records = Array.from(latestVendorEntries.values())
      .sort((left, right) => {
        if (left.supervisorCode !== right.supervisorCode) {
          return left.supervisorCode - right.supervisorCode;
        }
        return left.vendorCode - right.vendorCode;
      })
      .map((entry) => ({
        vendorCode: entry.vendorCode,
        vendorName: entry.vendorName,
        supervisorCode: entry.supervisorCode,
        referenceMonth: entry.batch.referenceMonth,
        email: emailByVendorCode.get(entry.vendorCode)?.email || ""
      }));

    return {
      records
    };
  });

  app.post("/api/modules/mei/email-base", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    if (user.role === "USER" && !user.supervisorCode) {
      return reply.code(400).send({ message: "Supervisor sem codigo configurado." });
    }

    const parsed = saveVendorEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados invalidos para salvar o email do vendedor." });
    }

    const vendor = await findAccessibleVendor(parsed.data.vendorCode, user);
    if (!vendor) {
      return reply.code(404).send({ message: "Vendedor nao encontrado para este usuario." });
    }

    const existing = await prisma.meiVendorEmail.findUnique({
      where: {
        vendorCode: parsed.data.vendorCode
      }
    });

    const saved = await prisma.$transaction(async (tx: any) => {
      const upserted = await tx.meiVendorEmail.upsert({
        where: {
          vendorCode: parsed.data.vendorCode
        },
        create: {
          vendorCode: parsed.data.vendorCode,
          email: parsed.data.email
        },
        update: {
          email: parsed.data.email
        }
      });

      await recordAudit(
        {
          actor: authUser,
          action: existing ? "MEI_UPDATE_VENDOR_EMAIL" : "MEI_CREATE_VENDOR_EMAIL",
          entityType: "MEI_VENDOR_EMAIL",
          entityId: String(parsed.data.vendorCode),
          summary: `Email do vendedor ${vendor.vendorName} foi salvo na base do MEI.`,
          before: existing
            ? {
                vendorCode: existing.vendorCode,
                email: existing.email
              }
            : null,
          after: {
            vendorCode: upserted.vendorCode,
            vendorName: vendor.vendorName,
            supervisorCode: vendor.supervisorCode,
            email: upserted.email
          }
        },
        tx
      );

      return upserted;
    });

    return {
      message: "Email do vendedor salvo com sucesso.",
      record: {
        vendorCode: saved.vendorCode,
        vendorName: vendor.vendorName,
        supervisorCode: vendor.supervisorCode,
        email: saved.email
      }
    };
  });

  app.put("/api/modules/mei/entries/:entryId", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const entryId = Number((request.params as { entryId: string }).entryId);
    if (!Number.isInteger(entryId) || entryId <= 0) {
      return reply.code(400).send({ message: "Registro MEI invalido." });
    }

    const parsed = updateEntrySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados invalidos para edicao manual do registro." });
    }

    const existingEntry = await prisma.meiCommissionEntry.findUnique({
      where: { id: entryId },
      include: {
        batch: {
          select: {
            id: true,
            referenceMonth: true
          }
        },
        submissions: {
          where: {
            isCurrent: true
          },
          take: 1,
          orderBy: {
            createdAt: "desc"
          },
          include: {
            uploadedByUser: {
              select: {
                id: true,
                username: true,
                displayName: true
              }
            },
            reviewedByUser: {
              select: {
                id: true,
                username: true,
                displayName: true
              }
            }
          }
        }
      }
    });

    if (!existingEntry) {
      return reply.code(404).send({ message: "Registro MEI nao encontrado." });
    }

    let normalizedPeriodStart: string;
    let normalizedPeriodEnd: string;

    try {
      normalizedPeriodStart = normalizeStoredDate(parsed.data.periodStart);
      normalizedPeriodEnd = normalizeStoredDate(parsed.data.periodEnd);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Datas invalidas para a entrada." });
    }

    if (normalizedPeriodStart > normalizedPeriodEnd) {
      return reply.code(400).send({ message: "A data de inicio nao pode ser maior que a data fim." });
    }

    const duplicateEntry = await prisma.meiCommissionEntry.findFirst({
      where: {
        batchId: existingEntry.batchId,
        vendorCode: parsed.data.vendorCode,
        id: {
          not: existingEntry.id
        }
      },
      select: {
        id: true
      }
    });

    if (duplicateEntry) {
      return reply.code(409).send({ message: "Ja existe outro vendedor com este codigo neste lote." });
    }

    const before = serializeEntry(existingEntry);

    const updatedEntry = await prisma.$transaction(async (tx: any) => {
      const updated = await tx.meiCommissionEntry.update({
        where: { id: entryId },
        data: {
          ...parsed.data,
          periodStart: normalizedPeriodStart,
          periodEnd: normalizedPeriodEnd
        },
        include: {
          batch: {
            select: {
              referenceMonth: true
            }
          },
          submissions: {
            where: {
              isCurrent: true
            },
            take: 1,
            orderBy: {
              createdAt: "desc"
            },
            include: {
              uploadedByUser: {
                select: {
                  id: true,
                  username: true,
                  displayName: true
                }
              },
              reviewedByUser: {
                select: {
                  id: true,
                  username: true,
                  displayName: true
                }
              }
            }
          }
        }
      });

      await recordAudit(
        {
          actor: authUser,
          action: "MEI_EDIT_ENTRY",
          entityType: "MEI_ENTRY",
          entityId: updated.id,
          summary: `Registro MEI do vendedor ${updated.vendorName} foi editado manualmente.`,
          before,
          after: serializeEntry(updated)
        },
        tx
      );

      return updated;
    });

    return {
      message: "Registro MEI atualizado com sucesso.",
      entry: serializeEntry(updatedEntry)
    };
  });

  app.post("/api/modules/mei/import/preview", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    try {
      const { part, buffer, fields } = await readMultipartFile(request as any);
      const referenceMonth = parseReferenceMonth(String(fields.referenceMonth?.value || ""));

      if (!String(part.filename || "").toLowerCase().endsWith(".xlsx")) {
        return reply.code(400).send({ message: "O arquivo do modulo MEI deve ser .xlsx." });
      }

      const rows = parseMeiSpreadsheet(buffer);
      validateNoDuplicateVendors(rows);

      const existingBatch = await prisma.meiImportBatch.findUnique({
        where: { referenceMonth },
        include: {
          entries: true
        }
      });

      const diff = existingBatch ? buildMeiBatchDiff(existingBatch.entries, rows) : null;

      const session = createPreviewSession({
        referenceMonth,
        originalFileName: part.filename,
        fileBuffer: buffer,
        rows
      });

      return {
        previewToken: session.token,
        referenceMonth,
        existingBatch: Boolean(existingBatch),
        originalFileName: part.filename,
        totalRows: rows.length,
        totals: buildImportSnapshot(referenceMonth, rows),
        previewRows: rows.slice(0, 12),
        changeSummary: diff?.summary || null,
        changesPreview: diff ? buildDiffPreview(diff) : []
      };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Falha ao ler a planilha." });
    }
  });

  app.post("/api/modules/mei/import/confirm", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const parsed = confirmImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Dados da importacao invalidos." });
    }

    const referenceMonth = parseReferenceMonth(parsed.data.referenceMonth);
    const previewSession = consumePreviewSession(parsed.data.previewToken);
    if (!previewSession || previewSession.referenceMonth !== referenceMonth) {
      return reply.code(400).send({ message: "Preview expirado ou invalido. Reenvie a planilha." });
    }

    const savedSpreadsheet = saveBufferToUploads(
      ["mei", "imports", referenceMonth],
      previewSession.originalFileName,
      previewSession.fileBuffer
    );

    const replacedFiles: string[] = [];

    try {
      await prisma.$transaction(async (tx: any) => {
        const existingBatch = await tx.meiImportBatch.findUnique({
          where: { referenceMonth },
          include: {
            entries: {
              include: {
                submissions: true
              }
            }
          }
        });

        if (existingBatch && !parsed.data.replaceExisting) {
          throw new Error("BATCH_EXISTS");
        }

        if (existingBatch) {
          replacedFiles.push(existingBatch.spreadsheetPath);

          const diff = buildMeiBatchDiff(existingBatch.entries, previewSession.rows);

          for (const item of diff.changedRows) {
            await tx.meiCommissionEntry.update({
              where: { id: item.existingEntry.id },
              data: {
                supervisorCode: item.nextRow.supervisorCode,
                vendorCode: item.nextRow.vendorCode,
                vendorName: item.nextRow.vendorName,
                periodStart: item.nextRow.periodStart,
                periodEnd: item.nextRow.periodEnd,
                grossSales: item.nextRow.grossSales,
                returnsAmount: item.nextRow.returnsAmount,
                netSales: item.nextRow.netSales,
                advanceAmount: item.nextRow.advanceAmount,
                delinquencyAmount: item.nextRow.delinquencyAmount,
                grossCommission: item.nextRow.grossCommission,
                averageCommissionPercent: item.nextRow.averageCommissionPercent,
                reversalAmount: item.nextRow.reversalAmount,
                totalCommissionToInvoice: item.nextRow.totalCommissionToInvoice,
                commissionToReceive: item.nextRow.commissionToReceive
              }
            });
          }

          if (diff.createdRows.length) {
            await tx.meiCommissionEntry.createMany({
              data: diff.createdRows.map((row) => ({
                batchId: existingBatch.id,
                periodStart: row.periodStart,
                periodEnd: row.periodEnd,
                supervisorCode: row.supervisorCode,
                vendorCode: row.vendorCode,
                vendorName: row.vendorName,
                grossSales: row.grossSales,
                returnsAmount: row.returnsAmount,
                netSales: row.netSales,
                advanceAmount: row.advanceAmount,
                delinquencyAmount: row.delinquencyAmount,
                grossCommission: row.grossCommission,
                averageCommissionPercent: row.averageCommissionPercent,
                reversalAmount: row.reversalAmount,
                totalCommissionToInvoice: row.totalCommissionToInvoice,
                commissionToReceive: row.commissionToReceive
              }))
            });
          }

          if (diff.removedEntries.length) {
            diff.removedEntries.forEach((entry: any) => {
              entry.submissions.forEach((submission: any) => {
                replacedFiles.push(submission.storagePath);
              });
            });

            await tx.meiCommissionEntry.deleteMany({
              where: {
                id: {
                  in: diff.removedEntries.map((entry: any) => entry.id)
                }
              }
            });
          }

          await tx.meiImportBatch.update({
            where: { id: existingBatch.id },
            data: {
              originalFileName: previewSession.originalFileName,
              spreadsheetPath: savedSpreadsheet.relativePath,
              totalRows: previewSession.rows.length,
              importedByUserId: authUser.userId
            }
          });

          await recordAudit(
            {
              actor: authUser,
              action:
                diff.summary.changed || diff.summary.created || diff.summary.removed ? "MEI_UPDATE_IMPORT" : "MEI_REFRESH_IMPORT",
              entityType: "MEI_BATCH",
              entityId: existingBatch.id,
              summary:
                diff.summary.changed || diff.summary.created || diff.summary.removed
                  ? `Planilha MEI de ${referenceMonth} foi atualizada por diferencas detectadas.`
                  : `Planilha MEI de ${referenceMonth} foi reenviada sem alteracoes nos valores.`,
              before: {
                referenceMonth: existingBatch.referenceMonth,
                totalRows: existingBatch.totalRows
              },
              after: {
                ...buildImportSnapshot(referenceMonth, previewSession.rows),
                changes: diff.summary
              }
            },
            tx
          );

          return;
        }

        const createdBatch = await tx.meiImportBatch.create({
          data: {
            referenceMonth,
            originalFileName: previewSession.originalFileName,
            spreadsheetPath: savedSpreadsheet.relativePath,
            totalRows: previewSession.rows.length,
            importedByUserId: authUser.userId
          }
        });

        await tx.meiCommissionEntry.createMany({
          data: previewSession.rows.map((row) => ({
            batchId: createdBatch.id,
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            supervisorCode: row.supervisorCode,
            vendorCode: row.vendorCode,
            vendorName: row.vendorName,
            grossSales: row.grossSales,
            returnsAmount: row.returnsAmount,
            netSales: row.netSales,
            advanceAmount: row.advanceAmount,
            delinquencyAmount: row.delinquencyAmount,
            grossCommission: row.grossCommission,
            averageCommissionPercent: row.averageCommissionPercent,
            reversalAmount: row.reversalAmount,
            totalCommissionToInvoice: row.totalCommissionToInvoice,
            commissionToReceive: row.commissionToReceive
          }))
        });

        await recordAudit(
          {
            actor: authUser,
            action: "MEI_IMPORT",
            entityType: "MEI_BATCH",
            entityId: createdBatch.id,
            summary: `Planilha MEI de ${referenceMonth} foi importada.`,
            before: null,
            after: buildImportSnapshot(referenceMonth, previewSession.rows)
          },
          tx
        );
      });
    } catch (error) {
      removeUpload(savedSpreadsheet.relativePath);

      if (error instanceof Error && error.message === "BATCH_EXISTS") {
        return reply.code(409).send({ message: "Ja existem dados para este mes. Confirme a aplicacao das alteracoes detectadas." });
      }

      throw error;
    }

    replacedFiles.forEach((relativePath) => removeUpload(relativePath));

    return {
      message: parsed.data.replaceExisting
        ? "Planilha MEI atualizada com sucesso."
        : "Planilha MEI importada com sucesso.",
      referenceMonth
    };
  });

  app.post("/api/modules/mei/invoices", { preHandler: [requireAuth, requireSupervisor] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active || !user.supervisorCode) {
      return reply.code(400).send({ message: "Supervisor sem codigo configurado." });
    }

    try {
      const { part, buffer, fields } = await readMultipartFile(request as any);
      const entryId = Number(String(fields.entryId?.value || ""));
      if (!Number.isInteger(entryId) || entryId <= 0) {
        return reply.code(400).send({ message: "Registro de vendedor invalido." });
      }

      const entry = await prisma.meiCommissionEntry.findUnique({
        where: { id: entryId },
        include: {
          batch: {
            select: {
              referenceMonth: true
            }
          },
          submissions: {
            where: {
              isCurrent: true
            },
            orderBy: {
              createdAt: "desc"
            },
            take: 1
          }
        }
      });

      if (!entry) {
        return reply.code(404).send({ message: "Registro MEI nao encontrado." });
      }

      if (entry.supervisorCode !== user.supervisorCode) {
        return reply.code(403).send({ message: "Sem acesso a este vendedor." });
      }

      const currentSubmission = entry.submissions[0] || null;
      if (currentSubmission?.status === "PENDING") {
        return reply.code(400).send({ message: "Ja existe uma nota pendente para este vendedor." });
      }

      if (currentSubmission?.status === "APPROVED") {
        return reply.code(400).send({ message: "Esta comissao ja foi aprovada e nao pode ser reenviada." });
      }

      const savedFile = saveBufferToUploads(
        ["mei", "invoices", entry.batch.referenceMonth, `supervisor-${entry.supervisorCode}`],
        part.filename,
        buffer
      );

      let submission: any;
      try {
        submission = await prisma.$transaction(async (tx: any) => {
          await tx.meiInvoiceSubmission.updateMany({
            where: {
              entryId: entry.id,
              isCurrent: true
            },
            data: {
              isCurrent: false
            }
          });

          const created = await tx.meiInvoiceSubmission.create({
            data: {
              entryId: entry.id,
              uploadedByUserId: user.id,
              status: "PENDING",
              isCurrent: true,
              originalFileName: part.filename,
              storagePath: savedFile.relativePath,
              mimeType: part.mimetype || "application/octet-stream",
              sizeBytes: buffer.length
            },
            include: {
              uploadedByUser: {
                select: {
                  id: true,
                  username: true,
                  displayName: true
                }
              }
            }
          });

          await recordAudit(
            {
              actor: authUser,
              action: currentSubmission ? "MEI_RESUBMIT_INVOICE" : "MEI_UPLOAD_INVOICE",
              entityType: "MEI_INVOICE",
              entityId: created.id,
              summary: `${user.displayName} enviou nota fiscal do vendedor ${entry.vendorName}.`,
              before: currentSubmission
                ? {
                    id: currentSubmission.id,
                    status: currentSubmission.status,
                    rejectionReason: currentSubmission.rejectionReason
                  }
                : null,
              after: {
                id: created.id,
                status: created.status,
                originalFileName: created.originalFileName,
                vendorCode: entry.vendorCode,
                referenceMonth: entry.batch.referenceMonth
              }
            },
            tx
          );

          return created;
        });
      } catch (error) {
        removeUpload(savedFile.relativePath);
        throw error;
      }

      return {
        message: "Nota fiscal enviada com sucesso.",
        submission: serializeSubmission(submission)
      };
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Falha no upload da nota." });
    }
  });

  app.get("/api/modules/mei/entries/:entryId/extract", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const entryId = Number((request.params as { entryId: string }).entryId);
    if (!Number.isInteger(entryId) || entryId <= 0) {
      return reply.code(400).send({ message: "Registro MEI invalido." });
    }

    const entry = await prisma.meiCommissionEntry.findUnique({
      where: { id: entryId },
      include: {
        batch: {
          select: {
            referenceMonth: true
          }
        },
        submissions: {
          where: {
            isCurrent: true
          },
          take: 1,
          orderBy: {
            createdAt: "desc"
          }
        }
      }
    });

    if (!entry) {
      return reply.code(404).send({ message: "Registro MEI nao encontrado." });
    }

    if (!ensureEntryAccess(entry, user)) {
      return reply.code(403).send({ message: "Sem acesso a este extrato." });
    }

    await recordAudit({
      actor: authUser,
      action: "MEI_DOWNLOAD_EXTRACT",
      entityType: "MEI_ENTRY",
      entityId: entry.id,
      summary: `Extrato do vendedor ${entry.vendorName} foi baixado.`,
      before: null,
      after: {
        referenceMonth: entry.batch.referenceMonth,
        vendorCode: entry.vendorCode
      }
    });

    const buffer = await buildMeiExtractPdfWithContext(entry, user.displayName);
    const safeFileName = buildExtractFileName(entry);

    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${safeFileName}"`)
      .send(buffer);
  });

  app.post("/api/modules/mei/entries/:entryId/send-email", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    if (!isEmailDeliveryConfigured()) {
      return reply.code(503).send({ message: "O envio por email via Amazon SES SMTP ainda nao esta configurado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const entryId = Number((request.params as { entryId: string }).entryId);
    if (!Number.isInteger(entryId) || entryId <= 0) {
      return reply.code(400).send({ message: "Registro MEI invalido." });
    }

    const entry = await prisma.meiCommissionEntry.findUnique({
      where: { id: entryId },
      include: {
        batch: {
          select: {
            referenceMonth: true
          }
        },
        submissions: {
          where: {
            isCurrent: true
          },
          take: 1,
          orderBy: {
            createdAt: "desc"
          }
        }
      }
    });

    if (!entry) {
      return reply.code(404).send({ message: "Registro MEI nao encontrado." });
    }

    if (!ensureEntryAccess(entry, user)) {
      return reply.code(403).send({ message: "Sem acesso a este extrato." });
    }

    const vendorEmail = await prisma.meiVendorEmail.findUnique({
      where: {
        vendorCode: entry.vendorCode
      }
    });

    if (!vendorEmail?.email) {
      return reply.code(400).send({ message: "Nenhum email cadastrado para este vendedor." });
    }

    const dispatch = await prisma.meiExtractEmailDispatch.create({
      data: {
        entryId: entry.id,
        sentByUserId: user.id,
        toEmail: vendorEmail.email,
        provider: getEmailProviderName(),
        status: "REQUESTED"
      }
    });

    try {
      const buffer = await buildMeiExtractPdfWithContext(entry, user.displayName);
      const safeFileName = buildExtractFileName(entry);
      const emailContent = buildMeiExtractEmailContent();
      const response = await sendTransactionalEmail({
        to: vendorEmail.email,
        subject: buildMeiExtractEmailSubject(entry),
        html: emailContent.html,
        text: emailContent.text,
        attachment: {
          filename: safeFileName,
          content: buffer,
          contentType: "application/pdf"
        }
      });

      const sentDispatch = await prisma.meiExtractEmailDispatch.update({
        where: { id: dispatch.id },
        data: {
          status: "SENT",
          providerMessageId: response.id,
          sentAt: new Date(),
          errorMessage: null
        }
      });

      await recordAudit({
        actor: authUser,
        action: "MEI_SEND_EXTRACT_EMAIL",
        entityType: "MEI_EMAIL_DISPATCH",
        entityId: sentDispatch.id,
        summary: `Extrato do vendedor ${entry.vendorName} foi enviado por email para ${vendorEmail.email}.`,
        before: null,
        after: {
          entryId: entry.id,
          vendorCode: entry.vendorCode,
          referenceMonth: entry.batch.referenceMonth,
          toEmail: vendorEmail.email,
          provider: sentDispatch.provider,
          providerMessageId: sentDispatch.providerMessageId,
          status: sentDispatch.status
        }
      });

      return {
        message: `Extrato enviado com sucesso para ${vendorEmail.email}.`,
        dispatch: {
          id: sentDispatch.id,
          toEmail: sentDispatch.toEmail,
          status: sentDispatch.status,
          providerMessageId: sentDispatch.providerMessageId,
          sentAt: sentDispatch.sentAt
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Falha ao enviar email.";

      const failedDispatch = await prisma.meiExtractEmailDispatch.update({
        where: { id: dispatch.id },
        data: {
          status: "FAILED",
          errorMessage
        }
      });

      await recordAudit({
        actor: authUser,
        action: "MEI_SEND_EXTRACT_EMAIL_FAILED",
        entityType: "MEI_EMAIL_DISPATCH",
        entityId: failedDispatch.id,
        summary: `Falha ao enviar extrato do vendedor ${entry.vendorName} para ${vendorEmail.email}.`,
        before: null,
        after: {
          entryId: entry.id,
          vendorCode: entry.vendorCode,
          referenceMonth: entry.batch.referenceMonth,
          toEmail: vendorEmail.email,
          provider: failedDispatch.provider,
          status: failedDispatch.status,
          errorMessage
        }
      });

      return reply.code(502).send({ message: errorMessage });
    }
  });

  app.get("/api/modules/mei/extract-emails/preview", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const query = (request.query as { referenceMonth?: string }) || {};
    const referenceMonth = parseReferenceMonth(query.referenceMonth || getPreviousReferenceMonth());

    const entries = await prisma.meiCommissionEntry.findMany({
      where: {
        batch: {
          referenceMonth
        }
      },
      include: {
        batch: {
          select: {
            referenceMonth: true
          }
        }
      },
      orderBy: [{ supervisorCode: "asc" }, { vendorName: "asc" }]
    });

    if (!entries.length) {
      return reply.code(404).send({ message: "Nenhum vendedor encontrado para este mes." });
    }

    const vendorEmails = await prisma.meiVendorEmail.findMany({
      where: {
        vendorCode: {
          in: entries.map((entry) => entry.vendorCode)
        }
      }
    });

    const preview = buildMeiExtractEmailBatchPreview(entries, vendorEmails);

    return {
      referenceMonth,
      emailConfigured: isEmailDeliveryConfigured(),
      subject: `Extrato MEI - Omega Distribuidora ${formatReferenceMonthSlash(referenceMonth)}`,
      ...preview
    };
  });

  app.post("/api/modules/mei/extract-emails/send-all", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    if (!isEmailDeliveryConfigured()) {
      return reply.code(503).send({ message: "O envio por email via Amazon SES SMTP ainda nao esta configurado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const parsed = sendAllExtractEmailsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Mes de referencia invalido." });
    }

    const referenceMonth = parseReferenceMonth(parsed.data.referenceMonth);
    const entries = await prisma.meiCommissionEntry.findMany({
      where: {
        batch: {
          referenceMonth
        }
      },
      include: {
        batch: {
          select: {
            referenceMonth: true
          }
        }
      },
      orderBy: [{ supervisorCode: "asc" }, { vendorName: "asc" }]
    });

    if (!entries.length) {
      return reply.code(404).send({ message: "Nenhum vendedor encontrado para este mes." });
    }

    const vendorEmails = await prisma.meiVendorEmail.findMany({
      where: {
        vendorCode: {
          in: entries.map((entry) => entry.vendorCode)
        }
      }
    });

    const preview = buildMeiExtractEmailBatchPreview(entries, vendorEmails);
    if (!preview.recipients.length) {
      return reply.code(400).send({ message: "Nenhum vendedor deste mes possui email cadastrado." });
    }

    const successes: Array<{ vendorCode: number; vendorName: string; email: string }> = [];
    const failures: Array<{ vendorCode: number; vendorName: string; email: string; errorMessage: string }> = [];
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));

    for (const recipient of preview.recipients) {
      const entry = entryById.get(recipient.entryId);
      if (!entry) {
        continue;
      }

      const dispatch = await prisma.meiExtractEmailDispatch.create({
        data: {
          entryId: entry.id,
          sentByUserId: user.id,
          toEmail: recipient.email,
          provider: getEmailProviderName(),
          status: "REQUESTED"
        }
      });

      try {
        const buffer = await buildMeiExtractPdfWithContext(entry, user.displayName);
        const safeFileName = buildExtractFileName(entry);
        const emailContent = buildMeiExtractEmailContent();
        const response = await sendTransactionalEmail({
          to: recipient.email,
          subject: buildMeiExtractEmailSubject(entry),
          html: emailContent.html,
          text: emailContent.text,
          attachment: {
            filename: safeFileName,
            content: buffer,
            contentType: "application/pdf"
          }
        });

        const sentDispatch = await prisma.meiExtractEmailDispatch.update({
          where: { id: dispatch.id },
          data: {
            status: "SENT",
            providerMessageId: response.id,
            sentAt: new Date(),
            errorMessage: null
          }
        });

        await recordAudit({
          actor: authUser,
          action: "MEI_SEND_EXTRACT_EMAIL",
          entityType: "MEI_EMAIL_DISPATCH",
          entityId: sentDispatch.id,
          summary: `Extrato do vendedor ${entry.vendorName} foi enviado por email para ${recipient.email}.`,
          before: null,
          after: {
            entryId: entry.id,
            vendorCode: entry.vendorCode,
            referenceMonth,
            toEmail: recipient.email,
            provider: sentDispatch.provider,
            providerMessageId: sentDispatch.providerMessageId,
            status: sentDispatch.status,
            bulk: true
          }
        });

        successes.push({
          vendorCode: entry.vendorCode,
          vendorName: entry.vendorName,
          email: recipient.email
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Falha ao enviar email.";
        const failedDispatch = await prisma.meiExtractEmailDispatch.update({
          where: { id: dispatch.id },
          data: {
            status: "FAILED",
            errorMessage
          }
        });

        await recordAudit({
          actor: authUser,
          action: "MEI_SEND_EXTRACT_EMAIL_FAILED",
          entityType: "MEI_EMAIL_DISPATCH",
          entityId: failedDispatch.id,
          summary: `Falha ao enviar extrato do vendedor ${entry.vendorName} para ${recipient.email}.`,
          before: null,
          after: {
            entryId: entry.id,
            vendorCode: entry.vendorCode,
            referenceMonth,
            toEmail: recipient.email,
            provider: failedDispatch.provider,
            status: failedDispatch.status,
            errorMessage,
            bulk: true
          }
        });

        failures.push({
          vendorCode: entry.vendorCode,
          vendorName: entry.vendorName,
          email: recipient.email,
          errorMessage
        });
      }
    }

    await recordAudit({
      actor: authUser,
      action: "MEI_SEND_ALL_EXTRACT_EMAILS",
      entityType: "MEI_BATCH",
      entityId: referenceMonth,
      summary: `Disparo em lote de extratos MEI executado para ${referenceMonth}.`,
      before: null,
      after: {
        referenceMonth,
        attempted: preview.recipients.length,
        sent: successes.length,
        failed: failures.length,
        skipped: preview.skipped.length
      }
    });

    return {
      message:
        failures.length > 0
          ? `${successes.length} extrato(s) enviado(s) com sucesso e ${failures.length} falha(s) no lote.`
          : `${successes.length} extrato(s) enviado(s) com sucesso.`,
      summary: {
        attempted: preview.recipients.length,
        sent: successes.length,
        failed: failures.length,
        skipped: preview.skipped.length
      },
      failures
    };
  });

  app.get("/api/modules/mei/invoices/:submissionId/download", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const submissionId = Number((request.params as { submissionId: string }).submissionId);
    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return reply.code(400).send({ message: "Nota fiscal invalida." });
    }

    const submission = await prisma.meiInvoiceSubmission.findUnique({
      where: { id: submissionId },
      include: {
        entry: {
          include: {
            batch: {
              select: {
                referenceMonth: true
              }
            }
          }
        }
      }
    });

    if (!submission) {
      return reply.code(404).send({ message: "Nota fiscal nao encontrada." });
    }

    if (!ensureEntryAccess(submission.entry, user)) {
      return reply.code(403).send({ message: "Sem acesso a esta nota fiscal." });
    }

    await recordAudit({
      actor: authUser,
      action: "MEI_DOWNLOAD_INVOICE",
      entityType: "MEI_INVOICE",
      entityId: submission.id,
      summary: `Nota fiscal do vendedor ${submission.entry.vendorName} foi baixada.`,
      before: null,
      after: {
        referenceMonth: submission.entry.batch.referenceMonth,
        vendorCode: submission.entry.vendorCode,
        originalFileName: submission.originalFileName
      }
    });

    return reply
      .header("Content-Type", submission.mimeType || "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${sanitizeFileName(submission.originalFileName)}"`)
      .send(readUpload(submission.storagePath));
  });

  app.post("/api/modules/mei/invoices/:submissionId/approve", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const submissionId = Number((request.params as { submissionId: string }).submissionId);
    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return reply.code(400).send({ message: "Nota fiscal invalida." });
    }

    const submission = await prisma.meiInvoiceSubmission.findUnique({
      where: { id: submissionId },
      include: {
        entry: {
          include: {
            batch: {
              select: {
                referenceMonth: true
              }
            }
          }
        }
      }
    });

    if (!submission || !submission.isCurrent) {
      return reply.code(404).send({ message: "Nota fiscal atual nao encontrada." });
    }

    const updated = await prisma.$transaction(async (tx: any) => {
      const approved = await tx.meiInvoiceSubmission.update({
        where: { id: submissionId },
        data: {
          status: "APPROVED",
          rejectionReason: null,
          reviewedAt: new Date(),
          reviewedByUserId: authUser.userId
        }
      });

      await recordAudit(
        {
          actor: authUser,
          action: "MEI_APPROVE_INVOICE",
          entityType: "MEI_INVOICE",
          entityId: approved.id,
          summary: `Nota fiscal do vendedor ${submission.entry.vendorName} foi aprovada.`,
          before: {
            status: submission.status,
            rejectionReason: submission.rejectionReason
          },
          after: {
            status: "APPROVED",
            referenceMonth: submission.entry.batch.referenceMonth,
            vendorCode: submission.entry.vendorCode
          }
        },
        tx
      );

      return approved;
    });

    return {
      message: "Nota fiscal aprovada com sucesso.",
      submission: {
        id: updated.id,
        status: updated.status
      }
    };
  });

  app.post("/api/modules/mei/invoices/:submissionId/reject", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const submissionId = Number((request.params as { submissionId: string }).submissionId);
    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return reply.code(400).send({ message: "Nota fiscal invalida." });
    }

    const parsed = rejectInvoiceSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Motivo invalido." });
    }

    const submission = await prisma.meiInvoiceSubmission.findUnique({
      where: { id: submissionId },
      include: {
        entry: {
          include: {
            batch: {
              select: {
                referenceMonth: true
              }
            }
          }
        }
      }
    });

    if (!submission || !submission.isCurrent) {
      return reply.code(404).send({ message: "Nota fiscal atual nao encontrada." });
    }

    const rejectionReason = String(parsed.data.reason || "").trim() || null;

    const updated = await prisma.$transaction(async (tx: any) => {
      const rejected = await tx.meiInvoiceSubmission.update({
        where: { id: submissionId },
        data: {
          status: "REJECTED",
          rejectionReason,
          reviewedAt: new Date(),
          reviewedByUserId: authUser.userId
        }
      });

      await recordAudit(
        {
          actor: authUser,
          action: "MEI_REJECT_INVOICE",
          entityType: "MEI_INVOICE",
          entityId: rejected.id,
          summary: `Nota fiscal do vendedor ${submission.entry.vendorName} foi recusada.`,
          before: {
            status: submission.status,
            rejectionReason: submission.rejectionReason
          },
          after: {
            status: "REJECTED",
            rejectionReason,
            referenceMonth: submission.entry.batch.referenceMonth,
            vendorCode: submission.entry.vendorCode
          }
        },
        tx
      );

      return rejected;
    });

    return {
      message: "Nota fiscal recusada com sucesso.",
      submission: {
        id: updated.id,
        status: updated.status,
        rejectionReason: updated.rejectionReason
      }
    };
  });

  app.post("/api/modules/mei/invoices/approve-all", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const parsed = approveAllSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "Mes de referencia invalido." });
    }

    const referenceMonth = parseReferenceMonth(parsed.data.referenceMonth);

    const submissions = await prisma.meiInvoiceSubmission.findMany({
      where: {
        isCurrent: true,
        status: "PENDING",
        entry: {
          batch: {
            referenceMonth
          }
        }
      },
      include: {
        entry: {
          include: {
            batch: {
              select: {
                referenceMonth: true
              }
            }
          }
        }
      }
    });

    if (!submissions.length) {
      return { message: "Nao ha notas pendentes para aprovar neste mes." };
    }

    await prisma.$transaction(async (tx: any) => {
      for (const submission of submissions) {
        await tx.meiInvoiceSubmission.update({
          where: { id: submission.id },
          data: {
            status: "APPROVED",
            rejectionReason: null,
            reviewedAt: new Date(),
            reviewedByUserId: authUser.userId
          }
        });

        await recordAudit(
          {
            actor: authUser,
            action: "MEI_APPROVE_INVOICE",
            entityType: "MEI_INVOICE",
            entityId: submission.id,
            summary: `Nota fiscal do vendedor ${submission.entry.vendorName} foi aprovada.`,
            before: {
              status: submission.status
            },
            after: {
              status: "APPROVED",
              referenceMonth,
              vendorCode: submission.entry.vendorCode,
              bulk: true
            }
          },
          tx
        );
      }

      await recordAudit(
        {
          actor: authUser,
          action: "MEI_APPROVE_ALL",
          entityType: "MEI_BATCH",
          entityId: referenceMonth,
          summary: `Todas as notas pendentes de ${referenceMonth} foram aprovadas.`,
          before: {
            pendingInvoices: submissions.length
          },
          after: {
            approvedInvoices: submissions.length
          }
        },
        tx
      );
    });

    return {
      message: `${submissions.length} nota(s) aprovada(s) com sucesso.`
    };
  });

  app.get("/api/modules/mei/invoices/download-all", { preHandler: [requireAuth, requireAdmin] }, async (request, reply) => {
    const query = (request.query as { referenceMonth?: string }) || {};
    const referenceMonth = parseReferenceMonth(query.referenceMonth || getPreviousReferenceMonth());

    const submissions = await prisma.meiInvoiceSubmission.findMany({
      where: {
        isCurrent: true,
        entry: {
          batch: {
            referenceMonth
          }
        }
      },
      include: {
        entry: true
      }
    });

    if (!submissions.length) {
      return reply.code(404).send({ message: "Nenhuma nota fiscal encontrada para este mes." });
    }

    submissions.sort((a, b) => {
      if (a.entry.supervisorCode !== b.entry.supervisorCode) {
        return a.entry.supervisorCode - b.entry.supervisorCode;
      }
      return a.entry.vendorCode - b.entry.vendorCode;
    });

    await recordAudit({
      actor: request.authUser,
      action: "MEI_DOWNLOAD_ALL_INVOICES",
      entityType: "MEI_BATCH",
      entityId: referenceMonth,
      summary: `Lote de notas fiscais de ${referenceMonth} foi baixado em zip.`,
      before: null,
      after: {
        referenceMonth,
        files: submissions.length
      }
    });

    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();

    archive.on("error", (error: Error) => {
      stream.destroy(error);
    });

    archive.pipe(stream);

    submissions.forEach((submission) => {
      const fileName = sanitizeFileName(
        `mei-${referenceMonth}-sup-${submission.entry.supervisorCode}-vend-${submission.entry.vendorCode}-${submission.originalFileName}`
      );
      archive.append(readUpload(submission.storagePath), { name: fileName });
    });

    void archive.finalize();

    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="notas-mei-${referenceMonth}.zip"`)
      .send(stream);
  });

  app.get("/api/modules/mei/extracts/download-all", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    if (user.role === "USER" && !user.supervisorCode) {
      return reply.code(400).send({ message: "Usuario supervisor sem codigo de supervisor configurado." });
    }

    const query = (request.query as { referenceMonth?: string }) || {};
    const referenceMonth = parseReferenceMonth(query.referenceMonth || getPreviousReferenceMonth());

    const entries = await prisma.meiCommissionEntry.findMany({
      where: {
        batch: {
          referenceMonth
        },
        ...(user.role === "USER" ? { supervisorCode: Number(user.supervisorCode || -1) } : {})
      },
      include: {
        batch: {
          select: {
            referenceMonth: true
          }
        }
      },
      orderBy: [{ supervisorCode: "asc" }, { vendorCode: "asc" }]
    });

    if (!entries.length) {
      return reply.code(404).send({ message: "Nenhum extrato encontrado para este mes." });
    }

    await recordAudit({
      actor: authUser,
      action: "MEI_DOWNLOAD_ALL_EXTRACTS",
      entityType: "MEI_BATCH",
      entityId: referenceMonth,
      summary: `Lote de extratos MEI de ${referenceMonth} foi baixado em zip.`,
      before: null,
      after: {
        referenceMonth,
        files: entries.length,
        role: user.role,
        supervisorCode: user.supervisorCode || null
      }
    });

    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();

    archive.on("error", (error: Error) => {
      stream.destroy(error);
    });

    archive.pipe(stream);

    for (const entry of entries) {
      const fileName = buildExtractFileName(entry);
      const buffer = await buildMeiExtractPdfWithContext(entry, user.displayName);
      archive.append(buffer, { name: fileName });
    }

    void archive.finalize();

    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="extratos-mei-${referenceMonth}.zip"`)
      .send(stream);
  });
}
