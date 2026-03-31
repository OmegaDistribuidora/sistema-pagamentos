import * as XLSX from "xlsx";

type VendorDirectoryRow = {
  supervisorCode: number;
  vendorCode: number;
  vendorName: string;
};

const HEADER_ALIASES = {
  supervisorCode: ["codsup", "codigo de supervisor", "cod supervisor", "supervisor"],
  vendorCode: ["codrca", "cod rca", "codigo de vendedor", "codigo vendedor", "cod vendedor", "vendedor"],
  vendorName: ["rca", "nome", "nome vendedor", "nome do vendedor"]
};

function normalizeHeader(value: unknown): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseIntegerCell(value: unknown, label: string, rowNumber: number): number {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error(`${label} obrigatorio na linha ${rowNumber}.`);
  }

  const normalized = raw.replace(/[.\s]/g, "").replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} invalido na linha ${rowNumber}: ${raw}.`);
  }

  return parsed;
}

function resolveColumnIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

export function parseVendorDirectorySpreadsheet(buffer: Buffer): VendorDirectoryRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("Planilha sem abas disponiveis.");
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    raw: false,
    defval: ""
  });

  if (!rows.length) {
    throw new Error("Planilha vazia.");
  }

  const headers = rows[0].map(normalizeHeader);
  const supervisorIndex = resolveColumnIndex(headers, HEADER_ALIASES.supervisorCode);
  const vendorCodeIndex = resolveColumnIndex(headers, HEADER_ALIASES.vendorCode);
  const vendorNameIndex = resolveColumnIndex(headers, HEADER_ALIASES.vendorName);

  if (supervisorIndex < 0 || vendorCodeIndex < 0 || vendorNameIndex < 0) {
    throw new Error(
      `Cabecalho invalido para a base de vendedores. Recebido: ${headers.filter(Boolean).join(", ")}.`
    );
  }

  const parsedRows: VendorDirectoryRow[] = [];
  const seenVendorCodes = new Set<number>();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const rowNumber = rowIndex + 1;

    const vendorName = String(row[vendorNameIndex] || "").trim();
    const supervisorRaw = String(row[supervisorIndex] || "").trim();
    const vendorCodeRaw = String(row[vendorCodeIndex] || "").trim();
    if (!vendorName && !supervisorRaw && !vendorCodeRaw) {
      continue;
    }

    const supervisorCode = parseIntegerCell(row[supervisorIndex], "Codigo de supervisor", rowNumber);
    const vendorCode = parseIntegerCell(row[vendorCodeIndex], "Codigo de vendedor", rowNumber);
    if (!vendorName) {
      throw new Error(`Nome do vendedor obrigatorio na linha ${rowNumber}.`);
    }

    if (seenVendorCodes.has(vendorCode)) {
      throw new Error(`Codigo de vendedor duplicado na linha ${rowNumber}: ${vendorCode}.`);
    }
    seenVendorCodes.add(vendorCode);

    parsedRows.push({
      supervisorCode,
      vendorCode,
      vendorName
    });
  }

  if (!parsedRows.length) {
    throw new Error("Nenhum vendedor valido foi encontrado na planilha.");
  }

  return parsedRows;
}
