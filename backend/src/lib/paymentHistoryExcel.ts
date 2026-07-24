import * as XLSX from "xlsx";

export const PAYMENT_HISTORY_EVENTS = [
  "Comissão",
  "Aj.de custo 1° P",
  "Aj.de custo 2° P",
  "Perfomance",
  "Campanha",
  "Performance Sup./Coord.",
  "Camp. Promotor",
  "Passagem",
  "RDV",
  "Consideração"
] as const;

export const PAYMENT_HISTORY_METHODS = ["Alelo", "Caju", "Depósito Bancário", "Pix"] as const;

export const PAYMENT_HISTORY_HEADERS = [
  "CodCoord",
  "Região",
  "CodSuperv",
  "Supervisor",
  "CodRca",
  "NomeRca",
  "Tipo",
  "Inadim./Vale",
  "Desc. MEI",
  "Total",
  "Total a Pagar",
  "Mês",
  "Ano",
  "Evento",
  "Fornecedor",
  "Forma de Pag.",
  "Liberação",
  "Usuário",
  "Dt. Registro",
  "Dt. Pagamento",
  "Mês Competência",
  "Obs"
] as const;

export const PAYMENT_HISTORY_MONTHS = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez"
] as const;

export type PaymentHistoryInput = {
  coordinatorCode: number;
  region: string;
  supervisorCode: number;
  supervisorName: string;
  personCode: number;
  personName: string;
  personType: string;
  delinquencyAmount: number;
  meiDiscountAmount: number;
  totalAmount: number;
  amountToPay: number;
  month: number;
  year: number;
  event: (typeof PAYMENT_HISTORY_EVENTS)[number];
  supplier: string;
  paymentMethod: (typeof PAYMENT_HISTORY_METHODS)[number];
  releaseBy: string;
  sourceUser: string;
  registeredAt: Date;
  paidAt: Date;
  competenceAt: Date;
  notes: string | null;
};

type ImportIssue = {
  row: number;
  message: string;
};

export class PaymentHistoryImportError extends Error {
  issues: ImportIssue[];

  constructor(issues: ImportIssue[]) {
    super(issues[0]?.message || "Planilha invalida.");
    this.name = "PaymentHistoryImportError";
    this.issues = issues;
  }
}

const HEADER_ALIASES: Record<keyof PaymentHistoryInput | "reportedTotal", string[]> = {
  coordinatorCode: ["CodCoord", "Cod. Coord", "Código Coordenador"],
  region: ["Região", "Regiao"],
  supervisorCode: ["CodSuperv", "Cód. Supervisor", "CodSupervisor"],
  supervisorName: ["Supervisor", "Nome Supervisor"],
  personCode: ["CodRca", "Cód", "Código"],
  personName: ["NomeRca", "Nome"],
  personType: ["Tipo"],
  delinquencyAmount: ["Inadim./Vale", "Inadim/Vale"],
  meiDiscountAmount: ["Desc. MEI", "Desc MEI"],
  reportedTotal: ["Total", "Total Premi.", "Total Prêmio"],
  totalAmount: [],
  amountToPay: ["Total a Pagar"],
  month: ["Mês", "Mes"],
  year: ["Ano"],
  event: ["Evento"],
  supplier: ["Fornecedor"],
  paymentMethod: ["Forma de Pag.", "Forma de Pagamento"],
  releaseBy: ["Liberação", "Liberacao"],
  sourceUser: ["Usuário", "Usuario"],
  registeredAt: ["Dt. Registro", "Data Registro"],
  paidAt: ["Dt. Pagamento", "Data Pagamento"],
  competenceAt: ["Mês Competência", "Mes Competencia", "Competência"],
  notes: ["Obs", "Observação", "Observacao"]
};

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function requiredText(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${label} é obrigatório.`);
  }
  return text;
}

function canonicalPersonType(value: unknown): string {
  const text = requiredText(value, "Tipo");
  const canonicalTypes = ["CLT", "MEI", "RCA"];
  return canonicalTypes.find((type) => normalize(type) === normalize(text)) || text;
}

function parseInteger(value: unknown, label: string): number {
  if (value == null || String(value).trim() === "") {
    throw new Error(`${label} é obrigatório.`);
  }
  const normalized = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^\d-]/g, ""));
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} deve ser um número inteiro positivo.`);
  }
  return normalized;
}

function parseAmount(value: unknown, label: string, optional = false): number {
  if (value == null || String(value).trim() === "") {
    if (optional) return 0;
    throw new Error(`${label} é obrigatório.`);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} é inválido.`);
    return Math.round(value * 100) / 100;
  }

  let normalized = String(value).trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} é inválido.`);
  }
  return Math.round(parsed * 100) / 100;
}

function parseMonth(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12) {
    return value;
  }

  const key = normalize(value).slice(0, 3);
  const monthIndex = PAYMENT_HISTORY_MONTHS.findIndex((month) => normalize(month).slice(0, 3) === key);
  if (monthIndex < 0) {
    throw new Error("Mês deve estar entre Jan e Dez.");
  }
  return monthIndex + 1;
}

function dateOnly(year: number, month: number, day: number): Date {
  const result = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  ) {
    throw new Error("Data inválida.");
  }
  return result;
}

function parseDate(value: unknown, label: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return dateOnly(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts) return dateOnly(parts.y, parts.m, parts.d);
  }

  const text = String(value ?? "").trim();
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    return dateOnly(year, Number(match[2]), Number(match[1]));
  }

  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return dateOnly(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  throw new Error(`${label} deve ser uma data válida no formato DD/MM/AAAA.`);
}

function canonicalOption<T extends readonly string[]>(value: unknown, options: T, label: string): T[number] {
  const key = normalize(value);
  const match = options.find((option) => normalize(option) === key);
  if (!match) {
    throw new Error(`${label} inválido: "${String(value ?? "").trim()}". Valores aceitos: ${options.join(", ")}.`);
  }
  return match as T[number];
}

export function calculatePaymentHistoryTotal(
  amountToPay: number,
  meiDiscountAmount: number,
  delinquencyAmount: number
): number {
  return Math.round((amountToPay + meiDiscountAmount + delinquencyAmount) * 100) / 100;
}

export function buildPaymentHistoryKey(
  record: Pick<PaymentHistoryInput, "event" | "personCode" | "month" | "year">
): string | null {
  if (normalize(record.event) === normalize("Consideração")) {
    return null;
  }
  return `${normalize(record.event)}|${record.personCode}|${record.year}|${record.month}`;
}

export function validatePaymentHistoryInput(value: unknown): PaymentHistoryInput {
  const input = (value || {}) as Record<string, unknown>;
  const delinquencyAmount = parseAmount(input.delinquencyAmount, "Inadim./Vale", true);
  const meiDiscountAmount = parseAmount(input.meiDiscountAmount, "Desc. MEI", true);
  const amountToPay = parseAmount(input.amountToPay, "Total a Pagar");
  const year = parseInteger(input.year, "Ano");
  if (year < 2000 || year > 2100) {
    throw new Error("Ano deve estar entre 2000 e 2100.");
  }

  return {
    coordinatorCode: parseInteger(input.coordinatorCode, "CodCoord"),
    region: requiredText(input.region, "Região"),
    supervisorCode: parseInteger(input.supervisorCode, "CodSuperv"),
    supervisorName: requiredText(input.supervisorName, "Supervisor"),
    personCode: parseInteger(input.personCode, "CodRca"),
    personName: requiredText(input.personName, "NomeRca"),
    personType: canonicalPersonType(input.personType),
    delinquencyAmount,
    meiDiscountAmount,
    totalAmount: calculatePaymentHistoryTotal(amountToPay, meiDiscountAmount, delinquencyAmount),
    amountToPay,
    month: parseMonth(input.month),
    year,
    event: canonicalOption(input.event, PAYMENT_HISTORY_EVENTS, "Evento"),
    supplier: requiredText(input.supplier, "Fornecedor"),
    paymentMethod: canonicalOption(input.paymentMethod, PAYMENT_HISTORY_METHODS, "Forma de pagamento"),
    releaseBy: requiredText(input.releaseBy, "Liberação"),
    sourceUser: String(input.sourceUser ?? "").trim(),
    registeredAt: parseDate(input.registeredAt, "Dt. Registro"),
    paidAt: parseDate(input.paidAt, "Dt. Pagamento"),
    competenceAt: parseDate(input.competenceAt, "Mês Competência"),
    notes: String(input.notes ?? "").trim() || null
  };
}

function findColumnIndexes(headerRow: unknown[]): Record<string, number> {
  const normalizedHeaders = headerRow.map(normalize);
  const result: Record<string, number> = {};

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (!aliases.length) continue;
    result[field] = normalizedHeaders.findIndex((header) => aliases.some((alias) => normalize(alias) === header));
  }
  return result;
}

function isHeaderRow(row: unknown[]): boolean {
  const indexes = findColumnIndexes(row);
  return ["personCode", "personName", "event", "paymentMethod", "month", "year", "amountToPay"].every(
    (field) => indexes[field] >= 0
  );
}

export function parsePaymentHistoryWorkbook(
  buffer: Buffer,
  options: { validateReportedTotal?: boolean } = {}
): PaymentHistoryInput[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  let rows: unknown[][] | null = null;
  let headerIndex = -1;

  for (const sheetName of workbook.SheetNames) {
    const candidateRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: null
    });
    const candidateHeader = candidateRows.slice(0, 25).findIndex(isHeaderRow);
    if (candidateHeader >= 0) {
      rows = candidateRows;
      headerIndex = candidateHeader;
      break;
    }
  }

  if (!rows || headerIndex < 0) {
    throw new PaymentHistoryImportError([
      { row: 1, message: "Não foi encontrada uma aba com os cabeçalhos do modelo de Histórico de Pagamentos." }
    ]);
  }

  const indexes = findColumnIndexes(rows[headerIndex]);
  const missingHeaders = Object.entries(HEADER_ALIASES)
    .filter(([field, aliases]) => aliases.length && field !== "reportedTotal" && indexes[field] < 0)
    .map(([, aliases]) => aliases[0]);
  if (missingHeaders.length) {
    throw new PaymentHistoryImportError([
      { row: headerIndex + 1, message: `Colunas obrigatórias ausentes: ${missingHeaders.join(", ")}.` }
    ]);
  }

  const issues: ImportIssue[] = [];
  const parsedRows: PaymentHistoryInput[] = [];

  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const spreadsheetRow = headerIndex + offset + 2;
    const hasContent = row.some((cell) => cell != null && String(cell).trim() !== "");
    if (!hasContent) return;

    try {
      const input = validatePaymentHistoryInput({
        coordinatorCode: row[indexes.coordinatorCode],
        region: row[indexes.region],
        supervisorCode: row[indexes.supervisorCode],
        supervisorName: row[indexes.supervisorName],
        personCode: row[indexes.personCode],
        personName: row[indexes.personName],
        personType: row[indexes.personType],
        delinquencyAmount: row[indexes.delinquencyAmount],
        meiDiscountAmount: row[indexes.meiDiscountAmount],
        amountToPay: row[indexes.amountToPay],
        month: row[indexes.month],
        year: row[indexes.year],
        event: row[indexes.event],
        supplier: row[indexes.supplier],
        paymentMethod: row[indexes.paymentMethod],
        releaseBy: row[indexes.releaseBy],
        sourceUser: row[indexes.sourceUser],
        registeredAt: row[indexes.registeredAt],
        paidAt: row[indexes.paidAt],
        competenceAt: row[indexes.competenceAt],
        notes: row[indexes.notes]
      });

      if (
        options.validateReportedTotal !== false &&
        indexes.reportedTotal >= 0 &&
        row[indexes.reportedTotal] != null &&
        String(row[indexes.reportedTotal]).trim()
      ) {
        const reportedTotal = parseAmount(row[indexes.reportedTotal], "Total");
        if (Math.abs(reportedTotal - input.totalAmount) > 0.01) {
          throw new Error(
            `Total incorreto. Esperado ${input.totalAmount.toFixed(2)} pela soma Total a Pagar + Desc. MEI + Inadim./Vale.`
          );
        }
      }

      parsedRows.push(input);
    } catch (error) {
      issues.push({
        row: spreadsheetRow,
        message: error instanceof Error ? error.message : "Dados inválidos."
      });
    }
  });

  if (issues.length) {
    throw new PaymentHistoryImportError(issues.slice(0, 200));
  }
  if (!parsedRows.length) {
    throw new PaymentHistoryImportError([{ row: headerIndex + 2, message: "A planilha não possui registros." }]);
  }
  return parsedRows;
}

function formatDateCell(value: Date | string): Date {
  const isoDate = (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function recordToExportRow(record: any) {
  return {
    CodCoord: record.coordinatorCode,
    Região: record.region,
    CodSuperv: record.supervisorCode,
    Supervisor: record.supervisorName,
    CodRca: record.personCode,
    NomeRca: record.personName,
    Tipo: record.personType,
    "Inadim./Vale": Number(record.delinquencyAmount || 0),
    "Desc. MEI": Number(record.meiDiscountAmount || 0),
    Total: Number(record.totalAmount || 0),
    "Total a Pagar": Number(record.amountToPay || 0),
    Mês: PAYMENT_HISTORY_MONTHS[Number(record.month) - 1] || record.month,
    Ano: record.year,
    Evento: record.event,
    Fornecedor: record.supplier,
    "Forma de Pag.": record.paymentMethod,
    Liberação: record.releaseBy,
    Usuário: record.sourceUser,
    "Dt. Registro": formatDateCell(record.registeredAt),
    "Dt. Pagamento": formatDateCell(record.paidAt),
    "Mês Competência": formatDateCell(record.competenceAt),
    Obs: record.notes || ""
  };
}

function applySheetFormatting(sheet: XLSX.WorkSheet, rowCount: number): void {
  sheet["!autofilter"] = { ref: `A1:V${Math.max(1, rowCount + 1)}` };
  sheet["!cols"] = PAYMENT_HISTORY_HEADERS.map((header) => ({
    wch: ["NomeRca", "Supervisor", "Fornecedor", "Obs"].includes(header) ? 28 : Math.max(12, header.length + 2)
  }));

  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:V1");
  for (let row = 1; row <= range.e.r; row += 1) {
    for (const column of [7, 8, 9, 10]) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell) cell.z = 'R$ #,##0.00';
    }
    for (const column of [18, 19, 20]) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell) cell.z = "dd/mm/yyyy";
    }
  }
}

export function buildPaymentHistoryExport(records: any[]): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet(records.map(recordToExportRow), {
    header: [...PAYMENT_HISTORY_HEADERS]
  });
  applySheetFormatting(sheet, records.length);
  XLSX.utils.book_append_sheet(workbook, sheet, "Histórico de Pagamentos");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

export function buildPaymentHistoryTemplate(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[...PAYMENT_HISTORY_HEADERS], new Array(PAYMENT_HISTORY_HEADERS.length).fill("")]);
  sheet["J2"] = { t: "n", v: 0, f: "K2+I2+H2", z: 'R$ #,##0.00' };
  applySheetFormatting(sheet, 1);
  XLSX.utils.book_append_sheet(workbook, sheet, "Histórico de Pagamentos");

  const instructions = XLSX.utils.aoa_to_sheet([
    ["Instruções"],
    ["O campo Total é calculado por: Total a Pagar + Desc. MEI + Inadim./Vale."],
    [],
    ["Eventos aceitos"],
    ...PAYMENT_HISTORY_EVENTS.map((value) => [value]),
    [],
    ["Formas de pagamento aceitas"],
    ...PAYMENT_HISTORY_METHODS.map((value) => [value]),
    [],
    ["Datas devem usar o formato DD/MM/AAAA."]
  ]);
  instructions["!cols"] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, instructions, "Instruções");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
