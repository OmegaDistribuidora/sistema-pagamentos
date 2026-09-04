import { z } from "zod";

export const COMMERCIAL_AGREEMENT_TYPES = [
  "INSERT",
  "LOYALTY",
  "STORE_OUTFIT",
  "PRODUCT_REGISTRY",
  "EXTRA_POINT",
  "OTHER"
] as const;

export const COMMERCIAL_AGREEMENT_ATTACHMENT_CATEGORIES = [
  "INVOICES",
  "TAX_INVOICE",
  "CONTRACT",
  "SALES_REPORT",
  "PHOTOS"
] as const;

export type CommercialAgreementType = (typeof COMMERCIAL_AGREEMENT_TYPES)[number];
export type CommercialAgreementAttachmentCategory = (typeof COMMERCIAL_AGREEMENT_ATTACHMENT_CATEGORIES)[number];

const supplierSchema = z.object({
  supplierCode: z.number().int().positive("Código de fornecedor inválido."),
  allocatedAmount: z.number().nonnegative("Valor rateado inválido.").optional()
});

const payloadSchema = z.object({
  audienceType: z.enum(["NETWORK", "SPECIFIC_CLIENTS"]),
  networkCode: z.number().int().positive("Código de rede inválido.").nullable().optional(),
  clientCodes: z.array(z.number().int().positive("Código de cliente inválido.")).default([]),
  agreementType: z.enum(COMMERCIAL_AGREEMENT_TYPES),
  otherDescription: z.string().trim().max(500, "A descrição deve ter no máximo 500 caracteres.").optional().default(""),
  totalAmount: z.number().positive("O valor total deve ser maior que zero."),
  splitAmount: z.boolean(),
  suppliers: z.array(supplierSchema).min(1, "Informe ao menos um fornecedor."),
  productCodes: z.array(z.number().int().positive("Código de produto inválido.")).default([]),
  notes: z.string().trim().max(2000, "A observação deve ter no máximo 2.000 caracteres.").optional().default("")
});

export type CommercialAgreementPayload = {
  audienceType: "NETWORK" | "SPECIFIC_CLIENTS";
  networkCode: number | null;
  clientCodes: number[];
  agreementType: CommercialAgreementType;
  otherDescription: string | null;
  totalAmount: number;
  splitAmount: boolean;
  suppliers: Array<{ supplierCode: number; allocatedAmount: number }>;
  productCodes: number[];
  notes: string | null;
};

function moneyToCents(value: number): number {
  return Math.round(value * 100);
}

function ensureUnique(values: number[], fieldLabel: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${fieldLabel} não pode conter códigos duplicados.`);
  }
}

export function agreementTypeRequiresProducts(type: CommercialAgreementType): boolean {
  return type === "PRODUCT_REGISTRY" || type === "INSERT" || type === "EXTRA_POINT";
}

export function requiredAttachmentCategories(
  type: CommercialAgreementType
): CommercialAgreementAttachmentCategory[] {
  return ["INVOICES", "SALES_REPORT", ...(type === "STORE_OUTFIT" ? [] : (["PHOTOS"] as const))];
}

export function parseCommercialAgreementPayload(value: unknown): CommercialAgreementPayload {
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || "Dados da solicitação inválidos.");
  }

  const data = parsed.data;
  const clientCodes = data.clientCodes;
  const productCodes = data.productCodes;
  const suppliers = data.suppliers;

  if (data.audienceType === "NETWORK" && !data.networkCode) {
    throw new Error("Informe o código da rede.");
  }
  if (data.audienceType === "SPECIFIC_CLIENTS" && !clientCodes.length) {
    throw new Error("Informe ao menos um código de cliente.");
  }

  ensureUnique(clientCodes, "A lista de clientes");
  ensureUnique(productCodes, "A lista de produtos");
  ensureUnique(
    suppliers.map((supplier) => supplier.supplierCode),
    "A lista de fornecedores"
  );

  if (data.agreementType === "OTHER" && !data.otherDescription) {
    throw new Error("Descreva o tipo de acordo comercial.");
  }
  if (agreementTypeRequiresProducts(data.agreementType) && !productCodes.length) {
    throw new Error("Informe ao menos um código de produto para este tipo de acordo.");
  }

  if (!data.splitAmount && suppliers.length !== 1) {
    throw new Error("Informe apenas um fornecedor quando o valor não for rateado.");
  }
  if (data.splitAmount && suppliers.length < 2) {
    throw new Error("Informe ao menos dois fornecedores para ratear o valor.");
  }

  const totalAmount = moneyToCents(data.totalAmount) / 100;
  const normalizedSuppliers = suppliers.map((supplier) => ({
    supplierCode: supplier.supplierCode,
    allocatedAmount: data.splitAmount
      ? moneyToCents(Number(supplier.allocatedAmount || 0)) / 100
      : totalAmount
  }));

  if (data.splitAmount && normalizedSuppliers.some((supplier) => supplier.allocatedAmount <= 0)) {
    throw new Error("O valor de cada fornecedor no rateio deve ser maior que zero.");
  }

  const allocatedCents = normalizedSuppliers.reduce(
    (sum, supplier) => sum + moneyToCents(supplier.allocatedAmount),
    0
  );
  if (allocatedCents !== moneyToCents(totalAmount)) {
    throw new Error("A soma dos valores rateados deve ser igual ao valor total.");
  }

  return {
    audienceType: data.audienceType,
    networkCode: data.audienceType === "NETWORK" ? data.networkCode || null : null,
    clientCodes: data.audienceType === "SPECIFIC_CLIENTS" ? clientCodes : [],
    agreementType: data.agreementType,
    otherDescription: data.agreementType === "OTHER" ? data.otherDescription : null,
    totalAmount,
    splitAmount: data.splitAmount,
    suppliers: normalizedSuppliers,
    productCodes: agreementTypeRequiresProducts(data.agreementType) ? productCodes : [],
    notes: data.notes || null
  };
}
