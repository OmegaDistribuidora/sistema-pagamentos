import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildPaymentHistoryKey, parsePaymentHistoryWorkbook } from "../src/lib/paymentHistoryExcel";

const defaultSource =
  "C:\\Users\\POWERBI\\OneDrive - omegadistribuidora.com.br\\Comercial\\Pagamentos\\Registro de pagamento.xlsx";
const sourcePath = path.resolve(process.argv[2] || defaultSource);
const outputPath = path.resolve(__dirname, "..", "src", "assets", "payment-history-initial.json.gz");

const parsedRows = parsePaymentHistoryWorkbook(fs.readFileSync(sourcePath), { validateReportedTotal: false });
const latestIndexByKey = new Map<string, number>();

parsedRows.forEach((row, index) => {
  const key = buildPaymentHistoryKey(row);
  if (key) latestIndexByKey.set(key, index);
});

const rows = parsedRows.filter((row, index) => {
  const key = buildPaymentHistoryKey(row);
  return !key || latestIndexByKey.get(key) === index;
});

fs.writeFileSync(outputPath, zlib.gzipSync(JSON.stringify(rows), { level: 9 }));

console.log(
  `Carga inicial gerada: ${rows.length} registros (${parsedRows.length - rows.length} duplicados removidos) em ${outputPath}`
);
