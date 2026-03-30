import * as XLSX from "xlsx";

type MeiSpreadsheetRow = {
  periodStart: string | null;
  periodEnd: string | null;
  supervisorCode: number;
  vendorCode: number;
  vendorName: string;
  grossSales: number;
  returnsAmount: number;
  netSales: number;
  advanceAmount: number;
  delinquencyAmount: number;
  grossCommission: number;
  averageCommissionPercent: number;
  reversalAmount: number;
  totalCommissionToInvoice: number;
  commissionToReceive: number;
};

type HeaderProfile = {
  name: string;
  columns: string[][];
  mapRow: (row: (string | number | null)[], rowNumber: number) => MeiSpreadsheetRow;
};

function normalizeHeader(value: unknown): string {
  return String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[^\w%]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function parseNumber(value: unknown, fieldName: string, rowNumber: number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Valor invalido em ${fieldName} na linha ${rowNumber}.`);
    }

    return value;
  }

  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error(`Valor invalido em ${fieldName} na linha ${rowNumber}.`);
  }

  const compact = raw.replace(/\s+/g, "");
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");

  let normalized = compact;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = compact.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = compact.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else if (lastDot >= 0) {
    const dotCount = (compact.match(/\./g) || []).length;
    const decimalDigits = compact.length - lastDot - 1;
    normalized =
      dotCount === 1 && decimalDigits > 0 && decimalDigits <= 4
        ? compact
        : compact.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Valor invalido em ${fieldName} na linha ${rowNumber}.`);
  }

  return parsed;
}

function parseInteger(value: unknown, fieldName: string, rowNumber: number): number {
  const parsed = parseNumber(value, fieldName, rowNumber);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Valor inteiro invalido em ${fieldName} na linha ${rowNumber}.`);
  }

  return parsed;
}

function formatIsoDate(year: number, month: number, day: number): string {
  const maxDay = new Date(year, month, 0).getDate();
  if (month < 1 || month > 12 || day < 1 || day > maxDay) {
    throw new Error("Data invalida.");
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDate(value: unknown, fieldName: string, rowNumber: number): string {
  if (typeof value === "number") {
    const parsedDate = XLSX.SSF.parse_date_code(value);
    if (!parsedDate?.y || !parsedDate?.m || !parsedDate?.d) {
      throw new Error(`Data invalida em ${fieldName} na linha ${rowNumber}.`);
    }

    return formatIsoDate(parsedDate.y, parsedDate.m, parsedDate.d);
  }

  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error(`Data invalida em ${fieldName} na linha ${rowNumber}.`);
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return formatIsoDate(Number(year), Number(month), Number(day));
  }

  const dashMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dashMatch) {
    const [, year, month, day] = dashMatch;
    return formatIsoDate(Number(year), Number(month), Number(day));
  }

  throw new Error(`Data invalida em ${fieldName} na linha ${rowNumber}.`);
}

function baseRow(
  row: (string | number | null)[],
  rowNumber: number
): Pick<MeiSpreadsheetRow, "periodStart" | "periodEnd" | "supervisorCode" | "vendorCode" | "vendorName"> {
  const vendorName = String(row[4] || "").trim();
  if (!vendorName) {
    throw new Error(`Nome do vendedor obrigatorio na linha ${rowNumber}.`);
  }

  return {
    periodStart: parseDate(row[0], "data inicio", rowNumber),
    periodEnd: parseDate(row[1], "data fim", rowNumber),
    supervisorCode: parseInteger(row[2], "codigo de supervisor", rowNumber),
    vendorCode: parseInteger(row[3], "codigo de vendedor", rowNumber),
    vendorName
  };
}

const HEADER_PROFILES: HeaderProfile[] = [
  {
    name: "detalhado-com-periodo",
    columns: [
      ["data inicio"],
      ["data fim"],
      ["codigo de supervisor"],
      ["codigo de vendedor"],
      ["nome"],
      ["venda bruta"],
      ["devolucao"],
      ["venda liquida"],
      ["adiantamento"],
      ["inadimplencia"],
      ["comissao bruta"],
      ["%comissao media"],
      ["estorno"],
      ["total comissao mes a faturar"],
      ["comissao a receber"]
    ],
    mapRow: (row, rowNumber) => ({
      ...baseRow(row, rowNumber),
      grossSales: parseNumber(row[5], "venda bruta", rowNumber),
      returnsAmount: parseNumber(row[6], "devolucao", rowNumber),
      netSales: parseNumber(row[7], "venda liquida", rowNumber),
      advanceAmount: parseNumber(row[8], "adiantamento", rowNumber),
      delinquencyAmount: parseNumber(row[9], "inadimplencia", rowNumber),
      grossCommission: parseNumber(row[10], "comissao bruta", rowNumber),
      averageCommissionPercent: parseNumber(row[11], "%comissao media", rowNumber),
      reversalAmount: parseNumber(row[12], "estorno", rowNumber),
      totalCommissionToInvoice: parseNumber(row[13], "total comissao mes a faturar", rowNumber),
      commissionToReceive: parseNumber(row[14], "comissao a receber", rowNumber)
    })
  },
  {
    name: "detalhado-sem-periodo",
    columns: [
      ["codigo de supervisor"],
      ["codigo de vendedor"],
      ["nome"],
      ["venda bruta"],
      ["devolucao"],
      ["venda liquida"],
      ["adiantamento"],
      ["inadimplencia"],
      ["comissao bruta"],
      ["%comissao media"],
      ["estorno"],
      ["total comissao mes a faturar"],
      ["comissao a receber"]
    ],
    mapRow: (row, rowNumber) => ({
      periodStart: null,
      periodEnd: null,
      supervisorCode: parseInteger(row[0], "codigo de supervisor", rowNumber),
      vendorCode: parseInteger(row[1], "codigo de vendedor", rowNumber),
      vendorName: String(row[2] || "").trim(),
      grossSales: parseNumber(row[3], "venda bruta", rowNumber),
      returnsAmount: parseNumber(row[4], "devolucao", rowNumber),
      netSales: parseNumber(row[5], "venda liquida", rowNumber),
      advanceAmount: parseNumber(row[6], "adiantamento", rowNumber),
      delinquencyAmount: parseNumber(row[7], "inadimplencia", rowNumber),
      grossCommission: parseNumber(row[8], "comissao bruta", rowNumber),
      averageCommissionPercent: parseNumber(row[9], "%comissao media", rowNumber),
      reversalAmount: parseNumber(row[10], "estorno", rowNumber),
      totalCommissionToInvoice: parseNumber(row[11], "total comissao mes a faturar", rowNumber),
      commissionToReceive: parseNumber(row[12], "comissao a receber", rowNumber)
    })
  },
  {
    name: "export-legado",
    columns: [
      ["codigo de supervisor", "codsup"],
      ["codigo de vendedor", "codusr", "codusur"],
      ["nome", "rca"],
      ["venda bruta", "vlvendabr"],
      ["total comissao mes a faturar", "vlcomissao"],
      ["%comissao media", "%com"],
      ["devolucao", "vldevolucao"],
      ["estorno", "vlestdevolucao"],
      ["venda liquida", "vendaliq"],
      ["comissao bruta", "vlcombruto"],
      ["adiantamento", "vlvale"],
      ["comissao a receber", "vlcomliq"]
    ],
    mapRow: (row, rowNumber) => ({
      periodStart: null,
      periodEnd: null,
      supervisorCode: parseInteger(row[0], "codigo de supervisor", rowNumber),
      vendorCode: parseInteger(row[1], "codigo de vendedor", rowNumber),
      vendorName: String(row[2] || "").trim(),
      grossSales: parseNumber(row[3], "venda bruta", rowNumber),
      returnsAmount: parseNumber(row[6], "devolucao", rowNumber),
      netSales: parseNumber(row[8], "venda liquida", rowNumber),
      advanceAmount: parseNumber(row[10], "adiantamento", rowNumber),
      delinquencyAmount: 0,
      grossCommission: parseNumber(row[9], "comissao bruta", rowNumber),
      averageCommissionPercent: parseNumber(row[5], "%comissao media", rowNumber),
      reversalAmount: parseNumber(row[7], "estorno", rowNumber),
      totalCommissionToInvoice: parseNumber(row[4], "total comissao mes a faturar", rowNumber),
      commissionToReceive: parseNumber(row[11], "comissao a receber", rowNumber)
    })
  }
];

function matchHeaderProfile(headerRow: (string | number | null)[]): HeaderProfile | null {
  const normalizedHeaders = headerRow.map(normalizeHeader);

  return (
    HEADER_PROFILES.find((profile) =>
      profile.columns.every((aliases, index) => aliases.map(normalizeHeader).includes(normalizedHeaders[index] || ""))
    ) || null
  );
}

export { type MeiSpreadsheetRow };

export function parseMeiSpreadsheet(buffer: Buffer): MeiSpreadsheetRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("Planilha vazia.");
  }

  const worksheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(worksheet, {
    header: 1,
    defval: null,
    raw: true
  });

  if (rows.length < 2) {
    throw new Error("A planilha deve conter cabecalho e pelo menos uma linha de dados.");
  }

  const headerRow = rows[0] || [];
  const matchedProfile = matchHeaderProfile(headerRow);
  if (!matchedProfile) {
    const receivedHeaders = headerRow
      .slice(0, 16)
      .map((header) => String(header || "").trim())
      .filter(Boolean)
      .join(", ");
    throw new Error(`Cabecalho da planilha invalido para o modulo MEI. Recebido: ${receivedHeaders || "vazio"}.`);
  }

  const parsedRows: MeiSpreadsheetRow[] = [];

  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    const emptyRow = row.every((cell) => String(cell ?? "").trim() === "");
    if (emptyRow) {
      return;
    }

    parsedRows.push(matchedProfile.mapRow(row, rowNumber));
  });

  if (!parsedRows.length) {
    throw new Error("Nenhuma linha valida foi encontrada na planilha.");
  }

  return parsedRows;
}
