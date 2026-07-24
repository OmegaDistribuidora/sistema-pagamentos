import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parsePaymentHistoryWorkbook } from "../src/lib/paymentHistoryExcel";

const defaultSource =
  "C:\\Users\\POWERBI\\OneDrive - omegadistribuidora.com.br\\Comercial\\Pagamentos\\Registro de pagamento.xlsx";
const sourcePath = path.resolve(process.argv[2] || defaultSource);
const outputPath = path.resolve(__dirname, "..", "src", "assets", "payment-history-initial.json.gz");

const rows = parsePaymentHistoryWorkbook(fs.readFileSync(sourcePath), { validateReportedTotal: false });
fs.writeFileSync(outputPath, zlib.gzipSync(JSON.stringify(rows), { level: 9 }));

console.log(`Carga inicial gerada: ${rows.length} registros em ${outputPath}`);
