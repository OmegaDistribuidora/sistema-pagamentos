import type { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";
import { getPreviousReferenceMonth } from "../lib/dates";
import { decimalToNumber } from "../lib/serialize";
import { requireAuth } from "../lib/security";
import { getEffectiveSupervisorCodes } from "../lib/userSupervisorCodes";

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dashboard", { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser;
    if (!authUser) {
      return reply.code(401).send({ message: "Usuario nao autenticado." });
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        supervisorCode: true,
        supervisorCodes: true,
        canViewPaymentHistory: true,
        canAccessCommercialAgreements: true,
        active: true
      }
    });

    if (!user || !user.active) {
      return reply.code(404).send({ message: "Usuario nao encontrado." });
    }

    const latestBatch = await prisma.meiImportBatch.findFirst({
      orderBy: { referenceMonth: "desc" },
      select: {
        referenceMonth: true
      }
    });

    const referenceMonth = latestBatch?.referenceMonth || getPreviousReferenceMonth();

    if (user.role === "ADMIN") {
      const [activeUsers, pendingInvoices] = await Promise.all([
        prisma.user.count({ where: { active: true } }),
        prisma.meiInvoiceSubmission.count({
          where: {
            isCurrent: true,
            status: "PENDING"
          }
        })
      ]);

      return {
        user,
        stats: {
          activeUsers,
          pendingInvoices,
          latestReferenceMonth: latestBatch?.referenceMonth || null
        },
        modules: [
          {
            key: "mei",
            title: "Pagamentos MEI",
            description: "Importe planilhas, acompanhe notas fiscais e feche aprovacoes do modulo MEI.",
            path: "/modules/mei"
          },
          {
            key: "audit",
            title: "Auditoria",
            description: "Consulte logins, uploads, aprovacoes, recusas e alteracoes administrativas.",
            path: "/admin/audit"
          },
          {
            key: "payment-history",
            title: "Historico de Pagamentos",
            description: "Consulte, importe e mantenha o historico consolidado de pagamentos.",
            path: "/modules/payment-history"
          },
          {
            key: "commercial-agreements",
            title: "Acordos Comerciais",
            description: "Analise solicitações de verbas e acompanhe acordos comerciais com fornecedores.",
            path: "/modules/commercial-agreements"
          }
        ]
      };
    }

    const supervisorCodes = getEffectiveSupervisorCodes(user);

    const entries = supervisorCodes.length
      ? await prisma.meiCommissionEntry.findMany({
          where: {
            supervisorCode: {
              in: supervisorCodes
            },
            batch: {
              referenceMonth
            }
          },
          select: {
            commissionToReceive: true
          }
        })
      : [];

    const totalCommission = entries.reduce((sum, entry) => sum + decimalToNumber(entry.commissionToReceive), 0);

    return {
      user,
      stats: {
        supervisorCode: supervisorCodes[0] ?? null,
        supervisorCodes,
        latestReferenceMonth: latestBatch?.referenceMonth || null,
        vendorsInLatestMonth: entries.length,
        totalCommission
      },
      modules: [
        {
          key: "mei",
          title: "Pagamentos MEI",
          description: "Envie notas fiscais, baixe extratos e acompanhe o status dos pagamentos do seu time.",
          path: "/modules/mei"
        },
        ...(user.role === "ANALYST" || user.canAccessCommercialAgreements
          ? [
              {
                key: "commercial-agreements",
                title: "Acordos Comerciais",
                description: "Crie e acompanhe suas solicitações de acordos comerciais.",
                path: "/modules/commercial-agreements"
              }
            ]
          : []),
        ...(user.role === "ANALYST" || user.canViewPaymentHistory
          ? [
              {
                key: "payment-history",
                title: "Historico de Pagamentos",
                description: "Consulte o historico de pagamentos associado aos seus supervisores.",
                path: "/modules/payment-history"
              }
            ]
          : [])
      ]
    };
  });
}
