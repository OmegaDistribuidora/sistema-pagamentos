import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import {
  COMMERCIAL_AGREEMENT_ATTACHMENT_CATEGORIES,
  COMMERCIAL_AGREEMENT_BILL_STATUSES,
  parseCommercialAgreementPayload,
  requiredAttachmentCategories,
  type CommercialAgreementAttachmentCategory,
  type CommercialAgreementPayload
} from "../lib/commercialAgreements";
import {
  generateCommercialAgreementPdfPreviews,
  PdfPreviewError,
  removeCommercialAgreementPreviews,
  resolveCommercialAgreementPreviewPath
} from "../lib/commercialAgreementPdfPreviews";
import { requireAuth } from "../lib/security";
import { readUpload, removeUpload, resolveUpload, sanitizeFileName, saveStreamToUploads } from "../lib/storage";
import type { AuthUser } from "../types";

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_REQUEST = 50;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp"
]);

const rejectSchema = z.object({
  reason: z.string().trim().min(1, "Informe o motivo da recusa.").max(1000, "O motivo deve ter no máximo 1.000 caracteres.")
});

const billStatusSchema = z.object({
  status: z.enum(COMMERCIAL_AGREEMENT_BILL_STATUSES)
});

type ActiveUser = {
  id: number;
  username: string;
  displayName: string;
  role: "ADMIN" | "ANALYST" | "USER";
  canAccessCommercialAgreements: boolean;
  active: boolean;
};

type SavedAttachment = {
  category: CommercialAgreementAttachmentCategory;
  originalFileName: string;
  mimeType: string;
  storagePath: string;
  sizeBytes: number;
  biAccessToken: string;
  totalPages: number | null;
};

const agreementInclude = {
  clients: { orderBy: { clientCode: "asc" as const } },
  suppliers: { orderBy: { supplierCode: "asc" as const } },
  products: { orderBy: { productCode: "asc" as const } },
  bills: { orderBy: { billNumber: "asc" as const } },
  attachments: { orderBy: [{ category: "asc" as const }, { createdAt: "asc" as const }] }
};

async function getActiveUser(userId: number): Promise<ActiveUser | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      canAccessCommercialAgreements: true,
      active: true
    }
  });
}

function canReviewAll(user: ActiveUser): boolean {
  return user.role === "ADMIN" || user.role === "ANALYST";
}

function canAccessModule(user: ActiveUser): boolean {
  return canReviewAll(user) || user.canAccessCommercialAgreements;
}

function serializeAgreement(agreement: any, includeHistory = false) {
  return {
    id: agreement.id,
    requester: {
      id: agreement.requesterUserId,
      username: agreement.requesterUsername,
      displayName: agreement.requesterDisplayName
    },
    audienceType: agreement.audienceType,
    networkCode: agreement.networkCode,
    clientCodes: (agreement.clients || []).map((item: any) => item.clientCode),
    agreementType: agreement.agreementType,
    otherDescription: agreement.otherDescription,
    totalAmount: Number(agreement.totalAmount),
    splitAmount: agreement.splitAmount,
    suppliers: (agreement.suppliers || []).map((item: any) => ({
      supplierCode: item.supplierCode,
      allocatedAmount: Number(item.allocatedAmount)
    })),
    productCodes: (agreement.products || []).map((item: any) => item.productCode),
    splitBills: agreement.splitBills,
    bills: (agreement.bills || []).map((item: any) => ({
      id: item.id,
      billNumber: item.billNumber,
      amount: Number(item.amount),
      dueDate: item.dueDate instanceof Date ? item.dueDate.toISOString().slice(0, 10) : String(item.dueDate).slice(0, 10),
      status: item.status
    })),
    notes: agreement.notes,
    status: agreement.status,
    rejectionReason: agreement.rejectionReason,
    submittedAt: agreement.submittedAt,
    reviewedAt: agreement.reviewedAt,
    resubmittedAt: agreement.resubmittedAt,
    reviewer: agreement.reviewerUserId
      ? {
          id: agreement.reviewerUserId,
          username: agreement.reviewerUsername,
          displayName: agreement.reviewerDisplayName
        }
      : null,
    attachments: (agreement.attachments || []).map((item: any) => ({
      id: item.id,
      category: item.category,
      originalFileName: item.originalFileName,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      totalPages: item.totalPages,
      createdAt: item.createdAt
    })),
    ...(includeHistory
      ? {
          history: (agreement.history || []).map((item: any) => ({
            id: item.id,
            action: item.action,
            previousStatus: item.previousStatus,
            nextStatus: item.nextStatus,
            actor: item.actorUsername
              ? {
                  id: item.actorUserId,
                  username: item.actorUsername,
                  displayName: item.actorDisplayName,
                  role: item.actorRole
                }
              : null,
            summary: item.summary,
            details: item.details,
            createdAt: item.createdAt
          }))
        }
      : {}),
    createdAt: agreement.createdAt,
    updatedAt: agreement.updatedAt
  };
}

function isAllowedAttachment(fileName: string, mimeType: string): boolean {
  return ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase()) && ALLOWED_MIME_TYPES.has(mimeType.toLowerCase());
}

function buildAttachmentEtag(attachment: {
  id: number;
  storagePath: string;
  sizeBytes: number;
  createdAt: Date;
}): string {
  const value = `${attachment.id}:${attachment.storagePath}:${attachment.sizeBytes}:${attachment.createdAt.getTime()}`;
  return `"${createHash("sha256").update(value).digest("hex")}"`;
}

function publicErrorStatus(error: unknown): number {
  return error instanceof PdfPreviewError ? error.statusCode : 400;
}

async function readAgreementMultipart(request: any, userId: number): Promise<{
  payload: CommercialAgreementPayload;
  attachments: SavedAttachment[];
}> {
  let rawPayload = "";
  const attachments: SavedAttachment[] = [];

  try {
    for await (const part of request.parts({
      limits: {
        fileSize: MAX_ATTACHMENT_SIZE,
        files: MAX_ATTACHMENTS_PER_REQUEST
      }
    })) {
      if (part.type === "field") {
        if (part.fieldname === "payload") {
          rawPayload = String(part.value || "");
        }
        continue;
      }

      if (!part.filename) {
        part.file.resume();
        continue;
      }

      if (!COMMERCIAL_AGREEMENT_ATTACHMENT_CATEGORIES.includes(part.fieldname as CommercialAgreementAttachmentCategory)) {
        part.file.resume();
        throw new Error("Categoria de anexo inválida.");
      }
      if (!isAllowedAttachment(part.filename, part.mimetype || "")) {
        part.file.resume();
        throw new Error("Os anexos devem ser arquivos PDF ou imagens JPG, JPEG, PNG, WEBP, GIF ou BMP.");
      }

      const target = await saveStreamToUploads(
        ["acordos-comerciais", `usuario-${userId}`, part.fieldname.toLowerCase()],
        part.filename,
        part.file
      );
      if (target.sizeBytes > MAX_ATTACHMENT_SIZE || part.file.truncated) {
        removeUpload(target.relativePath);
        throw new Error("Cada anexo deve ter no máximo 10 MB.");
      }

      attachments.push({
        category: part.fieldname as CommercialAgreementAttachmentCategory,
        originalFileName: part.filename,
        mimeType: part.mimetype,
        storagePath: target.relativePath,
        sizeBytes: target.sizeBytes,
        biAccessToken: randomUUID(),
        totalPages: null
      });
    }
  } catch (error: any) {
    attachments.forEach((attachment) => {
      removeUpload(attachment.storagePath);
      removeCommercialAgreementPreviews(attachment.biAccessToken);
    });
    if (error?.code === "FST_REQ_FILE_TOO_LARGE") {
      throw new Error("Cada anexo deve ter no máximo 10 MB.");
    }
    throw error;
  }

  if (!rawPayload) {
    removeSavedAttachments(attachments);
    throw new Error("Dados da solicitação não informados.");
  }

  let decodedPayload: unknown;
  try {
    decodedPayload = JSON.parse(rawPayload);
  } catch {
    removeSavedAttachments(attachments);
    throw new Error("Dados da solicitação inválidos.");
  }

  try {
    const payload = parseCommercialAgreementPayload(decodedPayload);
    const previewTotals = await generateCommercialAgreementPdfPreviews(attachments);
    attachments.forEach((attachment) => {
      attachment.totalPages = previewTotals.get(attachment.biAccessToken) ?? null;
    });
    return { payload, attachments };
  } catch (error) {
    attachments.forEach((attachment) => {
      removeUpload(attachment.storagePath);
      removeCommercialAgreementPreviews(attachment.biAccessToken);
    });
    throw error;
  }
}

function validateRequiredAttachments(
  agreementType: CommercialAgreementPayload["agreementType"],
  attachmentCategories: CommercialAgreementAttachmentCategory[]
): void {
  const available = new Set(attachmentCategories);
  const missing = requiredAttachmentCategories(agreementType).filter((category) => !available.has(category));
  if (missing.length) {
    const labels: Record<CommercialAgreementAttachmentCategory, string> = {
      INVOICES: "Boletos",
      TAX_INVOICE: "Nota Fiscal",
      CONTRACT: "Contrato/Termo de Ocorrência",
      SALES_REPORT: "Relatório de vendas",
      PHOTOS: "Fotos"
    };
    throw new Error(`Anexos obrigatórios ausentes: ${missing.map((item) => labels[item]).join(", ")}.`);
  }
}

function removeSavedAttachments(attachments: SavedAttachment[]): void {
  attachments.forEach((attachment) => {
    removeUpload(attachment.storagePath);
    removeCommercialAgreementPreviews(attachment.biAccessToken);
  });
}

function payloadRelations(payload: CommercialAgreementPayload) {
  return {
    clients: {
      create: payload.clientCodes.map((clientCode) => ({ clientCode }))
    },
    suppliers: {
      create: payload.suppliers.map((supplier) => supplier)
    },
    products: {
      create: payload.productCodes.map((productCode) => ({ productCode }))
    },
    bills: {
      create: payload.bills.map((bill) => ({
        billNumber: bill.billNumber,
        amount: bill.amount,
        dueDate: bill.dueDate
      }))
    }
  };
}

function payloadData(payload: CommercialAgreementPayload) {
  return {
    audienceType: payload.audienceType,
    networkCode: payload.networkCode,
    agreementType: payload.agreementType,
    otherDescription: payload.otherDescription,
    totalAmount: payload.totalAmount,
    splitAmount: payload.splitAmount,
    splitBills: payload.splitBills,
    notes: payload.notes
  };
}

function payloadSnapshot(payload: CommercialAgreementPayload) {
  return {
    ...payloadData(payload),
    clientCodes: payload.clientCodes,
    suppliers: payload.suppliers,
    productCodes: payload.productCodes,
    bills: payload.bills.map((bill) => ({
      billNumber: bill.billNumber,
      amount: bill.amount,
      dueDate: bill.dueDate.toISOString().slice(0, 10)
    }))
  };
}

async function recordAgreementHistory(
  tx: any,
  input: {
    agreementId: number;
    actor: ActiveUser;
    action: string;
    previousStatus?: "PENDING" | "APPROVED" | "REJECTED" | null;
    nextStatus?: "PENDING" | "APPROVED" | "REJECTED" | null;
    summary: string;
    details?: unknown;
  }
) {
  await tx.commercialAgreementHistory.create({
    data: {
      agreementId: input.agreementId,
      action: input.action,
      previousStatus: input.previousStatus ?? null,
      nextStatus: input.nextStatus ?? null,
      actorUserId: input.actor.id,
      actorUsername: input.actor.username,
      actorDisplayName: input.actor.displayName,
      actorRole: input.actor.role,
      summary: input.summary,
      details: input.details ?? undefined
    }
  });
}

async function getAccessibleAgreement(id: number, user: ActiveUser, includeHistory = false) {
  const agreement = await prisma.commercialAgreement.findFirst({
    where: {
      id,
      ...(canReviewAll(user) ? {} : { requesterUserId: user.id })
    },
    include: {
      ...agreementInclude,
      ...(includeHistory
        ? {
            history: {
              orderBy: { createdAt: "desc" as const }
            }
          }
        : {})
    }
  });
  return agreement;
}

function parsePositiveId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function registerCommercialAgreementRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/public/commercial-agreement-attachments/:token", async (request, reply) => {
    const token = String((request.params as { token: string }).token || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      return reply.code(404).send({ message: "Anexo não encontrado." });
    }

    const attachment = await prisma.commercialAgreementAttachment.findFirst({
      where: { biAccessToken: token }
    });
    if (!attachment) return reply.code(404).send({ message: "Anexo não encontrado." });

    const absolutePath = resolveUpload(attachment.storagePath);
    if (!fs.existsSync(absolutePath)) return reply.code(404).send({ message: "Arquivo não encontrado." });

    const etag = buildAttachmentEtag(attachment);
    if (request.headers["if-none-match"] === etag) {
      return reply.code(304).header("ETag", etag).send();
    }

    const safeFileName = sanitizeFileName(attachment.originalFileName);
    return reply
      .header("Content-Type", attachment.mimeType || "application/octet-stream")
      .header("Content-Length", String(attachment.sizeBytes))
      .header(
        "Content-Disposition",
        `inline; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(attachment.originalFileName)}`
      )
      .header("Cache-Control", "public, max-age=86400, s-maxage=86400, stale-if-error=3600")
      .header("ETag", etag)
      .header("X-Content-Type-Options", "nosniff")
      .send(fs.createReadStream(absolutePath));
  });

  app.get("/api/public/commercial-agreement-attachments/:token/preview/:page", async (request, reply) => {
    const params = request.params as { token: string; page: string };
    const token = String(params.token || "").trim();
    const rawPage = String(params.page || "");
    const page = /^[1-9]\d*$/.test(rawPage) ? parsePositiveId(rawPage) : null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token) || !page) {
      return reply.code(404).header("Cache-Control", "no-store").send({ message: "Preview não encontrado." });
    }

    const attachment = await prisma.commercialAgreementAttachment.findFirst({
      where: { biAccessToken: token },
      select: { originalFileName: true, mimeType: true, totalPages: true }
    });
    if (
      !attachment ||
      attachment.mimeType.toLowerCase() !== "application/pdf" ||
      !attachment.totalPages ||
      page > attachment.totalPages
    ) {
      return reply.code(404).header("Cache-Control", "no-store").send({ message: "Preview não encontrado." });
    }

    const previewPath = resolveCommercialAgreementPreviewPath(token, page);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(previewPath);
      if (!stats.isFile()) throw new Error("Preview ausente.");
    } catch {
      return reply.code(404).header("Cache-Control", "no-store").send({ message: "Arquivo de preview não encontrado." });
    }

    const etag = `"${createHash("sha256").update(`${token}:${page}:${stats.size}`).digest("hex")}"`;
    if (request.headers["if-none-match"] === etag) {
      return reply.code(304).header("Cache-Control", "public, max-age=604800, s-maxage=604800, immutable").header("ETag", etag).send();
    }

    const sanitizedFileName = sanitizeFileName(attachment.originalFileName);
    const baseName = path.basename(sanitizedFileName, path.extname(sanitizedFileName));
    return reply
      .header("Content-Type", "image/webp")
      .header("Content-Length", String(stats.size))
      .header("Content-Disposition", `inline; filename="${baseName || "documento"}-pagina-${page}.webp"`)
      .header("Cache-Control", "public, max-age=604800, s-maxage=604800, immutable")
      .header("ETag", etag)
      .header("X-Content-Type-Options", "nosniff")
      .send(fs.createReadStream(previewPath));
  });

  app.get("/api/modules/commercial-agreements", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });

    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
    if (!canAccessModule(user)) return reply.code(403).send({ message: "Usuário sem acesso ao módulo Acordos Comerciais." });

    const reviewer = canReviewAll(user);
    const query = (request.query || {}) as { requesterUserId?: string };
    const requestedUserId = parsePositiveId(String(query.requesterUserId || ""));
    const agreements = await prisma.commercialAgreement.findMany({
      where: reviewer
        ? requestedUserId
          ? { requesterUserId: requestedUserId }
          : undefined
        : { requesterUserId: user.id },
      include: agreementInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }]
    });

    const requesters = reviewer
      ? Array.from(
          new Map(
            agreements.filter((item) => item.requesterUserId != null).map((item) => [
              item.requesterUserId,
              {
                id: item.requesterUserId,
                username: item.requesterUsername,
                displayName: item.requesterDisplayName
              }
            ])
          ).values()
        ).sort((left, right) => left.displayName.localeCompare(right.displayName, "pt-BR"))
      : [];

    return {
      agreements: agreements.map((agreement) => serializeAgreement(agreement)),
      requesters,
      canReview: reviewer
    };
  });

  app.get("/api/modules/commercial-agreements/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });
    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
    if (!canAccessModule(user)) return reply.code(403).send({ message: "Usuário sem acesso ao módulo Acordos Comerciais." });

    const id = parsePositiveId((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ message: "Solicitação inválida." });
    const reviewer = canReviewAll(user);
    const agreement = await getAccessibleAgreement(id, user, reviewer);
    if (!agreement) return reply.code(404).send({ message: "Solicitação não encontrada." });

    return {
      agreement: serializeAgreement(agreement, reviewer),
      canReview: reviewer
    };
  });

  app.post("/api/modules/commercial-agreements", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });
    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
    if (!canAccessModule(user)) return reply.code(403).send({ message: "Usuário sem acesso ao módulo Acordos Comerciais." });

    let multipart: Awaited<ReturnType<typeof readAgreementMultipart>> | undefined;
    try {
      multipart = await readAgreementMultipart(request, user.id);
      validateRequiredAttachments(
        multipart.payload.agreementType,
        multipart.attachments.map((item) => item.category)
      );
    } catch (error) {
      if (multipart) removeSavedAttachments(multipart.attachments);
      return reply.code(publicErrorStatus(error)).send({ message: error instanceof Error ? error.message : "Solicitação inválida." });
    }

    const savedAttachments = multipart.attachments;
    try {
      const created = await prisma.$transaction(async (tx: any) => {
        const agreement = await tx.commercialAgreement.create({
          data: {
            requesterUserId: user.id,
            requesterUsername: user.username,
            requesterDisplayName: user.displayName,
            ...payloadData(multipart.payload),
            status: "PENDING",
            ...payloadRelations(multipart.payload),
            attachments: {
              create: savedAttachments.map((item) => ({
                category: item.category,
                biAccessToken: item.biAccessToken,
                originalFileName: item.originalFileName,
                storagePath: item.storagePath,
                mimeType: item.mimeType,
                sizeBytes: item.sizeBytes,
                totalPages: item.totalPages
              }))
            }
          },
          include: agreementInclude
        });

        await recordAgreementHistory(tx, {
          agreementId: agreement.id,
          actor: user,
          action: "CRIADA",
          previousStatus: null,
          nextStatus: "PENDING",
          summary: `${user.displayName} criou a solicitação de acordo comercial.`,
          details: payloadSnapshot(multipart.payload)
        });
        await recordAudit(
          {
            actor: authUser,
            actorUser: user,
            action: "COMMERCIAL_AGREEMENT_CREATE",
            entityType: "COMMERCIAL_AGREEMENT",
            entityId: agreement.id,
            summary: `${user.displayName} criou uma solicitação de acordo comercial.`,
            before: null,
            after: payloadSnapshot(multipart.payload)
          },
          tx
        );
        return agreement;
      });

      return reply.code(201).send({
        message: "Solicitação enviada com sucesso.",
        agreement: serializeAgreement(created)
      });
    } catch (error) {
      removeSavedAttachments(savedAttachments);
      throw error;
    }
  });

  app.put("/api/modules/commercial-agreements/:id/resubmit", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });
    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
    if (!canAccessModule(user)) return reply.code(403).send({ message: "Usuário sem acesso ao módulo Acordos Comerciais." });

    const id = parsePositiveId((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ message: "Solicitação inválida." });
    const existing = await prisma.commercialAgreement.findFirst({
      where: { id, requesterUserId: user.id },
      include: agreementInclude
    });
    if (!existing) return reply.code(404).send({ message: "Solicitação não encontrada." });
    if (existing.status !== "REJECTED") {
      return reply.code(409).send({ message: "Somente solicitações recusadas podem ser editadas e reenviadas." });
    }

    let multipart: Awaited<ReturnType<typeof readAgreementMultipart>> | undefined;
    try {
      multipart = await readAgreementMultipart(request, user.id);
      const replacedCategories = new Set(multipart.attachments.map((item) => item.category));
      const nextCategories = [
        ...existing.attachments.filter((item) => !replacedCategories.has(item.category)).map((item) => item.category),
        ...multipart.attachments.map((item) => item.category)
      ];
      validateRequiredAttachments(multipart.payload.agreementType, nextCategories);
    } catch (error) {
      if (multipart) removeSavedAttachments(multipart.attachments);
      return reply.code(publicErrorStatus(error)).send({ message: error instanceof Error ? error.message : "Solicitação inválida." });
    }

    const replacedCategories = Array.from(new Set(multipart.attachments.map((item) => item.category)));
    const replacedAttachments = existing.attachments.filter((item) => replacedCategories.includes(item.category));
    const savedAttachments = multipart.attachments;

    try {
      const updated = await prisma.$transaction(async (tx: any) => {
        const agreement = await tx.commercialAgreement.update({
          where: { id, status: "REJECTED" },
          data: {
            ...payloadData(multipart.payload),
            status: "PENDING",
            rejectionReason: null,
            reviewedAt: null,
            resubmittedAt: new Date(),
            reviewerUserId: null,
            reviewerUsername: null,
            reviewerDisplayName: null,
            clients: {
              deleteMany: {},
              create: multipart.payload.clientCodes.map((clientCode) => ({ clientCode }))
            },
            suppliers: {
              deleteMany: {},
              create: multipart.payload.suppliers
            },
            products: {
              deleteMany: {},
              create: multipart.payload.productCodes.map((productCode) => ({ productCode }))
            },
            bills: {
              deleteMany: {},
              create: multipart.payload.bills.map((bill) => ({
                billNumber: bill.billNumber,
                amount: bill.amount,
                dueDate: bill.dueDate
              }))
            },
            ...(replacedCategories.length
              ? {
                  attachments: {
                    deleteMany: { category: { in: replacedCategories } },
                    create: savedAttachments.map((item) => ({
                      category: item.category,
                      biAccessToken: item.biAccessToken,
                      originalFileName: item.originalFileName,
                      storagePath: item.storagePath,
                      mimeType: item.mimeType,
                      sizeBytes: item.sizeBytes,
                      totalPages: item.totalPages
                    }))
                  }
                }
              : {})
          },
          include: agreementInclude
        });

        await recordAgreementHistory(tx, {
          agreementId: id,
          actor: user,
          action: "REENVIADA",
          previousStatus: "REJECTED",
          nextStatus: "PENDING",
          summary: `${user.displayName} editou e reenviou a solicitação.`,
          details: payloadSnapshot(multipart.payload)
        });
        await recordAudit(
          {
            actor: authUser,
            actorUser: user,
            action: "COMMERCIAL_AGREEMENT_RESUBMIT",
            entityType: "COMMERCIAL_AGREEMENT",
            entityId: id,
            summary: `${user.displayName} editou e reenviou uma solicitação de acordo comercial.`,
            before: { status: "REJECTED", rejectionReason: existing.rejectionReason },
            after: { status: "PENDING", ...payloadSnapshot(multipart.payload) }
          },
          tx
        );
        return agreement;
      });

      replacedAttachments.forEach((attachment) => {
        removeUpload(attachment.storagePath);
        removeCommercialAgreementPreviews(attachment.biAccessToken);
      });
      return {
        message: "Solicitação corrigida e reenviada para análise.",
        agreement: serializeAgreement(updated)
      };
    } catch (error) {
      removeSavedAttachments(savedAttachments);
      if ((error as any)?.code === "P2025") {
        return reply.code(409).send({ message: "A solicitação já foi reenviada ou alterada." });
      }
      throw error;
    }
  });

  app.post("/api/modules/commercial-agreements/:id/approve", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });
    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
    if (!canAccessModule(user)) return reply.code(403).send({ message: "Usuário sem acesso ao módulo Acordos Comerciais." });
    if (!canReviewAll(user)) return reply.code(403).send({ message: "Acesso restrito a administradores e analistas." });

    const id = parsePositiveId((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ message: "Solicitação inválida." });
    const existing = await prisma.commercialAgreement.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ message: "Solicitação não encontrada." });
    if (existing.status !== "PENDING") return reply.code(409).send({ message: "A solicitação não está pendente." });

    let updated;
    try {
      updated = await prisma.$transaction(async (tx: any) => {
        const result = await tx.commercialAgreement.updateMany({
          where: { id, status: "PENDING" },
          data: {
            status: "APPROVED",
            rejectionReason: null,
            reviewedAt: new Date(),
            reviewerUserId: user.id,
            reviewerUsername: user.username,
            reviewerDisplayName: user.displayName
          }
        });
        if (result.count !== 1) throw new Error("AGREEMENT_NOT_PENDING");
        const agreement = await tx.commercialAgreement.findUniqueOrThrow({ where: { id }, include: agreementInclude });
        await recordAgreementHistory(tx, {
          agreementId: id,
          actor: user,
          action: "APROVADA",
          previousStatus: "PENDING",
          nextStatus: "APPROVED",
          summary: `${user.displayName} aprovou a solicitação.`
        });
        await recordAudit(
          {
            actor: authUser,
            actorUser: user,
            action: "COMMERCIAL_AGREEMENT_APPROVE",
            entityType: "COMMERCIAL_AGREEMENT",
            entityId: id,
            summary: `${user.displayName} aprovou uma solicitação de acordo comercial.`,
            before: { status: "PENDING" },
            after: { status: "APPROVED" }
          },
          tx
        );
        return agreement;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "AGREEMENT_NOT_PENDING") {
        return reply.code(409).send({ message: "A solicitação já foi analisada." });
      }
      throw error;
    }

    return { message: "Solicitação aprovada com sucesso.", agreement: serializeAgreement(updated) };
  });

  app.post("/api/modules/commercial-agreements/:id/reject", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });
    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
    if (!canAccessModule(user)) return reply.code(403).send({ message: "Usuário sem acesso ao módulo Acordos Comerciais." });
    if (!canReviewAll(user)) return reply.code(403).send({ message: "Acesso restrito a administradores e analistas." });

    const id = parsePositiveId((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ message: "Solicitação inválida." });
    const parsed = rejectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.issues[0]?.message || "Motivo da recusa inválido." });
    }
    const existing = await prisma.commercialAgreement.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ message: "Solicitação não encontrada." });
    if (existing.status !== "PENDING") return reply.code(409).send({ message: "A solicitação não está pendente." });

    let updated;
    try {
      updated = await prisma.$transaction(async (tx: any) => {
        const result = await tx.commercialAgreement.updateMany({
          where: { id, status: "PENDING" },
          data: {
            status: "REJECTED",
            rejectionReason: parsed.data.reason,
            reviewedAt: new Date(),
            reviewerUserId: user.id,
            reviewerUsername: user.username,
            reviewerDisplayName: user.displayName
          }
        });
        if (result.count !== 1) throw new Error("AGREEMENT_NOT_PENDING");
        const agreement = await tx.commercialAgreement.findUniqueOrThrow({ where: { id }, include: agreementInclude });
        await recordAgreementHistory(tx, {
          agreementId: id,
          actor: user,
          action: "RECUSADA",
          previousStatus: "PENDING",
          nextStatus: "REJECTED",
          summary: `${user.displayName} recusou a solicitação.`,
          details: { reason: parsed.data.reason }
        });
        await recordAudit(
          {
            actor: authUser,
            actorUser: user,
            action: "COMMERCIAL_AGREEMENT_REJECT",
            entityType: "COMMERCIAL_AGREEMENT",
            entityId: id,
            summary: `${user.displayName} recusou uma solicitação de acordo comercial.`,
            before: { status: "PENDING" },
            after: { status: "REJECTED", reason: parsed.data.reason }
          },
          tx
        );
        return agreement;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "AGREEMENT_NOT_PENDING") {
        return reply.code(409).send({ message: "A solicitação já foi analisada." });
      }
      throw error;
    }

    return { message: "Solicitação recusada. O usuário poderá corrigi-la e reenviá-la.", agreement: serializeAgreement(updated) };
  });

  app.patch(
    "/api/modules/commercial-agreements/:id/bills/:billId/status",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const authUser = request.authUser;
      if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });
      const user = await getActiveUser(authUser.userId);
      if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
      if (!canAccessModule(user)) return reply.code(403).send({ message: "Usuário sem acesso ao módulo Acordos Comerciais." });
      if (!canReviewAll(user)) return reply.code(403).send({ message: "Somente administradores e analistas podem alterar o status dos boletos." });

      const params = request.params as { id: string; billId: string };
      const agreementId = parsePositiveId(params.id);
      const billId = parsePositiveId(params.billId);
      if (!agreementId || !billId) return reply.code(400).send({ message: "Boleto inválido." });

      const parsed = billStatusSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: "O status do boleto deve ser Pago ou Pendente." });

      const existing = await prisma.commercialAgreementBill.findFirst({
        where: { id: billId, agreementId },
        include: { agreement: true }
      });
      if (!existing) return reply.code(404).send({ message: "Boleto não encontrado." });
      if (existing.agreement.status === "REJECTED") {
        return reply.code(409).send({ message: "Não é possível alterar boletos de uma solicitação recusada." });
      }

      if (existing.status !== parsed.data.status) {
        try {
          await prisma.$transaction(async (tx: any) => {
            const currentAgreement = await tx.commercialAgreement.findUnique({ where: { id: agreementId } });
            if (!currentAgreement) throw new Error("AGREEMENT_NOT_FOUND");
            if (currentAgreement.status === "REJECTED") throw new Error("AGREEMENT_REJECTED");

            const changed = await tx.commercialAgreementBill.updateMany({
              where: { id: billId, agreementId, status: existing.status },
              data: { status: parsed.data.status }
            });
            if (changed.count !== 1) throw new Error("BILL_STATUS_CHANGED");

            await tx.commercialAgreement.update({
              where: { id: agreementId },
              data: { updatedAt: new Date() }
            });
            const nextLabel = parsed.data.status === "PAID" ? "Pago" : "Pendente";
            const previousLabel = existing.status === "PAID" ? "Pago" : "Pendente";
            await recordAgreementHistory(tx, {
              agreementId,
              actor: user,
              action: parsed.data.status === "PAID" ? "BOLETO_PAGO" : "BOLETO_PENDENTE",
              summary: `${user.displayName} alterou o boleto ${existing.billNumber} para ${nextLabel}.`,
              details: {
                billId,
                billNumber: existing.billNumber,
                previousStatus: previousLabel,
                nextStatus: nextLabel
              }
            });
            await recordAudit(
              {
                actor: authUser,
                actorUser: user,
                action: "COMMERCIAL_AGREEMENT_BILL_STATUS_UPDATE",
                entityType: "COMMERCIAL_AGREEMENT",
                entityId: agreementId,
                summary: `${user.displayName} alterou o status do boleto ${existing.billNumber} para ${nextLabel}.`,
                before: { billId, billNumber: existing.billNumber, status: existing.status },
                after: { billId, billNumber: existing.billNumber, status: parsed.data.status }
              },
              tx
            );
          });
        } catch (error) {
          if (error instanceof Error && error.message === "AGREEMENT_NOT_FOUND") {
            return reply.code(404).send({ message: "Solicitação não encontrada." });
          }
          if (error instanceof Error && error.message === "AGREEMENT_REJECTED") {
            return reply.code(409).send({ message: "Não é possível alterar boletos de uma solicitação recusada." });
          }
          if (error instanceof Error && error.message === "BILL_STATUS_CHANGED") {
            return reply.code(409).send({ message: "O status do boleto foi alterado por outro usuário. Atualize a solicitação e tente novamente." });
          }
          throw error;
        }
      }

      const updated = await getAccessibleAgreement(agreementId, user, true);
      if (!updated) return reply.code(404).send({ message: "Solicitação não encontrada." });
      const label = parsed.data.status === "PAID" ? "Pago" : "Pendente";
      return {
        message: `Boleto ${existing.billNumber} marcado como ${label}.`,
        agreement: serializeAgreement(updated, true)
      };
    }
  );

  app.delete("/api/modules/commercial-agreements/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });
    const user = await getActiveUser(authUser.userId);
    if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
    if (user.role !== "ADMIN") {
      return reply.code(403).send({ message: "Somente administradores podem excluir solicitações." });
    }

    const id = parsePositiveId((request.params as { id: string }).id);
    if (!id) return reply.code(400).send({ message: "Solicitação inválida." });

    const existing = await prisma.commercialAgreement.findUnique({
      where: { id },
      include: { attachments: true }
    });
    if (!existing) return reply.code(404).send({ message: "Solicitação não encontrada." });

    await prisma.$transaction(async (tx: any) => {
      await tx.auditLog.deleteMany({
        where: {
          entityType: "COMMERCIAL_AGREEMENT",
          entityId: String(id)
        }
      });
      await tx.commercialAgreement.delete({ where: { id } });
    });

    existing.attachments.forEach((attachment) => {
      removeUpload(attachment.storagePath);
      removeCommercialAgreementPreviews(attachment.biAccessToken);
    });

    return {
      message: `Solicitação #${id} e todos os seus dados foram excluídos com sucesso.`
    };
  });

  app.get(
    "/api/modules/commercial-agreements/:id/attachments/:attachmentId/download",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const authUser = request.authUser;
      if (!authUser) return reply.code(401).send({ message: "Usuário não autenticado." });
      const user = await getActiveUser(authUser.userId);
      if (!user || !user.active) return reply.code(404).send({ message: "Usuário não encontrado." });
      if (!canAccessModule(user)) return reply.code(403).send({ message: "Usuário sem acesso ao módulo Acordos Comerciais." });

      const params = request.params as { id: string; attachmentId: string };
      const id = parsePositiveId(params.id);
      const attachmentId = parsePositiveId(params.attachmentId);
      if (!id || !attachmentId) return reply.code(400).send({ message: "Anexo inválido." });

      const attachment = await prisma.commercialAgreementAttachment.findFirst({
        where: {
          id: attachmentId,
          agreementId: id,
          ...(canReviewAll(user) ? {} : { agreement: { requesterUserId: user.id } })
        }
      });
      if (!attachment) return reply.code(404).send({ message: "Anexo não encontrado." });

      return reply
        .header("Content-Type", attachment.mimeType || "application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${sanitizeFileName(attachment.originalFileName)}"`)
        .send(readUpload(attachment.storagePath));
    }
  );
}
