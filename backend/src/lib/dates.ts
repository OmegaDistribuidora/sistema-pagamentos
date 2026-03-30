const BRAZIL_TIMEZONE = "America/Sao_Paulo";

function getFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRAZIL_TIMEZONE,
    ...options
  });
}

function getBrazilDateParts(baseDate = new Date()): Record<string, string> {
  return getFormatter({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .formatToParts(baseDate)
    .reduce<Record<string, string>>((accumulator, part) => {
      if (part.type !== "literal") {
        accumulator[part.type] = part.value;
      }
      return accumulator;
    }, {});
}

export function parseReferenceMonth(value: string): string {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalized)) {
    throw new Error("Mes de referencia invalido.");
  }

  const [year, month] = normalized.split("-").map(Number);
  if (month < 1 || month > 12) {
    throw new Error("Mes de referencia invalido.");
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function getPreviousReferenceMonth(baseDate = new Date()): string {
  const parts = getBrazilDateParts(baseDate);
  let year = Number(parts.year);
  let month = Number(parts.month) - 1;

  if (month === 0) {
    month = 12;
    year -= 1;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function formatReferenceMonth(referenceMonth: string): string {
  const [year, month] = parseReferenceMonth(referenceMonth).split("-").map(Number);
  const date = new Date(year, month - 1, 1);
  return getFormatter({
    month: "long",
    year: "numeric"
  }).format(date);
}

export function formatBrazilDate(baseDate = new Date()): string {
  return getFormatter({
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(baseDate);
}

export function formatBrazilTime(baseDate = new Date()): string {
  return getFormatter({
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(baseDate);
}

export function getBrazilDateStamp(baseDate = new Date()): string {
  const parts = getBrazilDateParts(baseDate);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getBrazilTimeZone(): string {
  return BRAZIL_TIMEZONE;
}

export function getReferenceMonthDateRange(referenceMonth: string): { start: string; end: string } {
  const [year, month] = parseReferenceMonth(referenceMonth).split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`,
    end: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
  };
}

export function normalizeStoredDate(value: string): string {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error("Data invalida.");
  }

  const [year, month, day] = normalized.split("-").map(Number);
  const maxDay = new Date(year, month, 0).getDate();
  if (month < 1 || month > 12 || day < 1 || day > maxDay) {
    throw new Error("Data invalida.");
  }

  return normalized;
}

export function formatStoredDate(value: string): string {
  const normalized = normalizeStoredDate(value);
  const [year, month, day] = normalized.split("-");
  return `${day}/${month}/${year}`;
}

export function formatStoredDateRange(start: string, end: string): string {
  return `${formatStoredDate(start)} até ${formatStoredDate(end)}`;
}
