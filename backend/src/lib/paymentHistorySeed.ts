import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import prisma from "./prisma";
import type { PaymentHistoryInput } from "./paymentHistoryExcel";

const INITIAL_DATA_FILE = path.resolve(__dirname, "..", "assets", "payment-history-initial.json.gz");

export async function ensurePaymentHistoryInitialData(): Promise<void> {
  const existingCount = await prisma.paymentHistoryRecord.count();
  if (existingCount || !fs.existsSync(INITIAL_DATA_FILE)) return;

  const compressed = fs.readFileSync(INITIAL_DATA_FILE);
  const rows = JSON.parse(zlib.gunzipSync(compressed).toString("utf8")) as PaymentHistoryInput[];
  const batchSize = 500;

  await prisma.$transaction(
    async (tx) => {
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        await tx.paymentHistoryRecord.createMany({
          data: batch.map((row) => ({
            ...row,
            registeredAt: new Date(row.registeredAt),
            paidAt: new Date(row.paidAt),
            competenceAt: new Date(row.competenceAt),
            origin: "INITIAL",
            sourceFileName: "Registro de pagamento.xlsx"
          }))
        });
      }
    },
    { maxWait: 10_000, timeout: 60_000 }
  );

  console.log(`Historico de Pagamentos inicializado com ${rows.length} registros.`);
}
