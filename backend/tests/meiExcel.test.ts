import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { parseMeiSpreadsheet } from "../src/lib/meiExcel";

function createWorkbookBuffer(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Dados");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

const arbitraryHeaders = Array.from({ length: 15 }, (_, index) => `Cabecalho livre ${index + 1}`);

test("reads the fixed 15-column layout without validating header names", () => {
  const [row] = parseMeiSpreadsheet(
    createWorkbookBuffer([
      arbitraryHeaders,
      ["01/08/2026", "31/08/2026", 10, 20, "Pessoa Teste", 1000, 50, 950, 100, 25, 200, 20, 10, 190, 90]
    ])
  );

  assert.deepEqual(row, {
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    supervisorCode: 10,
    vendorCode: 20,
    vendorName: "Pessoa Teste",
    grossSales: 1000,
    returnsAmount: 50,
    netSales: 950,
    advanceAmount: 100,
    delinquencyAmount: 25,
    grossCommission: 200,
    averageCommissionPercent: 20,
    reversalAmount: 10,
    totalCommissionToInvoice: 190,
    commissionToReceive: 90
  });
});

test("converts blank financial cells to zero", () => {
  const [row] = parseMeiSpreadsheet(
    createWorkbookBuffer([
      arbitraryHeaders,
      ["01/08/2026", "31/08/2026", 10, 20, "Pessoa Teste", "", null, "", null, "", 0, "", null, "", 0]
    ])
  );

  assert.equal(row.grossSales, 0);
  assert.equal(row.returnsAmount, 0);
  assert.equal(row.netSales, 0);
  assert.equal(row.advanceAmount, 0);
  assert.equal(row.delinquencyAmount, 0);
  assert.equal(row.grossCommission, 0);
  assert.equal(row.averageCommissionPercent, 0);
  assert.equal(row.reversalAmount, 0);
  assert.equal(row.totalCommissionToInvoice, 0);
  assert.equal(row.commissionToReceive, 0);
});

test("rejects the former 13-column layout", () => {
  const oldHeaders = Array.from({ length: 13 }, (_, index) => `Coluna ${index + 1}`);

  assert.throws(
    () => parseMeiSpreadsheet(createWorkbookBuffer([oldHeaders, [10, 20, "Pessoa", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]])),
    /pelo menos 15 colunas/
  );
});

test("still rejects non-numeric content in financial cells", () => {
  assert.throws(
    () =>
      parseMeiSpreadsheet(
        createWorkbookBuffer([
          arbitraryHeaders,
          ["01/08/2026", "31/08/2026", 10, 20, "Pessoa Teste", "texto-invalido", 0, 0, 0, 0, 0, 0, 0, 0, 0]
        ])
      ),
    /Valor invalido em venda bruta/
  );
});
