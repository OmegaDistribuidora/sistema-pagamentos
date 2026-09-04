import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import prisma from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import {
  COMMERCIAL_AGREEMENT_ATTACHMENT_CATEGORIES,
  parseCommercialAgreementPayload,
  requiredAttachmentCategories,
  type CommercialAgreementAttachmentCategory,
  type CommercialAgreementPayload
} from "../lib/commercialAgreements";
import { requireAuth } from "../lib/security";
import { readUpload, removeUpload, sanitizeFileName, saveBufferToUploads } from "../lib/storage";
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

type ActiveUser = {
  id: number;
  username: string;
  displayName: string;
  role: "ADMIN" | "ANALYST" | "USER";
  canAccessCommercialAgreements: boolean;
  active: boolean;
};

type IncomingAttachment = {
  category: CommercialAgreementAttachmentCategory;
  originalFileName: string;
  mimeType: string;
  buffer: Buffer;
};

type SavedAttachment = Omit<IncomingAttachment, "buffer"> & {
  storagePath: string;
  sizeBytes: number;
};

const agreementInclude = {
  clients: { orderBy: { clientCode: "asc" as const } },
  suppliers: { orderBy: { supplierCode: "asc" as const } },
  products: { orderBy: { productCode: "asc" as const } },
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

async function readAgreementMultipart(request: any): Promise<{
  payload: CommercialAgreementPayload;
  attachments: IncomingAttachment[];
}> {
  let rawPayload = "";
  const attachments: IncomingAttachment[] = [];

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

      const buffer = await part.toBuffer();
      if (buffer.length > MAX_ATTACHMENT_SIZE || part.file.truncated) {
        throw new Error("Cada anexo deve ter no máximo 10 MB.");
      }

      attachments.push({
        category: part.fieldname as CommercialAgreementAttachmentCategory,
        originalFileName: part.filename,
        mimeType: part.mimetype,
        buffer
      });
    }
  } catch (error: any) {
    if (error?.code === "FST_REQ_FILE_TOO_LARGE") {
      throw new Error("Cada anexo deve ter no máximo 10 MB.");
    }
    throw error;
  }

  if (!rawPayload) {
    throw new Error("Dados da solicitação não informados.");
  }

  let decodedPayload: unknown;
  try {
    decodedPayload = JSON.parse(rawPayload);
  } catch {
    throw new Error("Dados da solicitação inválidos.");
  }

  return {
    payload: parseCommercialAgreementPayload(decodedPayload),
    attachments
  };
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

function saveAttachments(userId: number, attachments: IncomingAttachment[]): SavedAttachment[] {
  const saved: SavedAttachment[] = [];
  try {
    for (const attachment of attachments) {
      const target = saveBufferToUploads(
        ["acordos-comerciais", `usuario-${userId}`, attachment.category.toLowerCase()],
        attachment.originalFileName,
        attachment.buffer
      );
      saved.push({
        category: attachment.category,
        originalFileName: attachment.originalFileName,
        mimeType: attachment.mimeType,
        storagePath: target.relativePath,
        sizeBytes: attachment.buffer.length
      });
    }
    return saved;
  } catch (error) {
    saved.forEach((item) => removeUpload(item.storagePath));
    throw error;
  }
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
    notes: payload.notes
  };
}

function payloadSnapshot(payload: CommercialAgreementPayload) {
  return {
    ...payloadData(payload),
    clientCodes: payload.clientCodes,
    suppliers: payload.suppliers,
    productCodes: payload.productCodes
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

    let multipart;
    try {
      multipart = await readAgreementMultipart(request);
      validateRequiredAttachments(
        multipart.payload.agreementType,
        multipart.attachments.map((item) => item.category)
      );
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Solicitação inválida." });
    }

    const savedAttachments = saveAttachments(user.id, multipart.attachments);
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
                originalFileName: item.originalFileName,
                storagePath: item.storagePath,
                mimeType: item.mimeType,
                sizeBytes: item.sizeBytes
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
      savedAttachments.forEach((item) => removeUpload(item.storagePath));
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

    let multipart;
    try {
      multipart = await readAgreementMultipart(request);
      const replacedCategories = new Set(multipart.attachments.map((item) => item.category));
      const nextCategories = [
        ...existing.attachments.filter((item) => !replacedCategories.has(item.category)).map((item) => item.category),
        ...multipart.attachments.map((item) => item.category)
      ];
      validateRequiredAttachments(multipart.payload.agreementType, nextCategories);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Solicitação inválida." });
    }

    const replacedCategories = Array.from(new Set(multipart.attachments.map((item) => item.category)));
    const replacedFiles = existing.attachments
      .filter((item) => replacedCategories.includes(item.category))
      .map((item) => item.storagePath);
    const savedAttachments = saveAttachments(user.id, multipart.attachments);

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
            ...(replacedCategories.length
              ? {
                  attachments: {
                    deleteMany: { category: { in: replacedCategories } },
                    create: savedAttachments.map((item) => ({
                      category: item.category,
                      originalFileName: item.originalFileName,
                      storagePath: item.storagePath,
                      mimeType: item.mimeType,
                      sizeBytes: item.sizeBytes
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

      replacedFiles.forEach((filePath) => removeUpload(filePath));
      return {
        message: "Solicitação corrigida e reenviada para análise.",
        agreement: serializeAgreement(updated)
      };
    } catch (error) {
      savedAttachments.forEach((item) => removeUpload(item.storagePath));
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

    existing.attachments.forEach((attachment) => removeUpload(attachment.storagePath));

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
