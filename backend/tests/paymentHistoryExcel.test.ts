import assert from "node:assert/strict";
import test from "node:test";

import { buildPaymentHistoryKey } from "../src/lib/paymentHistoryExcel";

function record(event: string, supplier: string) {
  return {
    event,
    supplier,
    personCode: 1192,
    month: 8,
    year: 2026
  } as any;
}

test("campaign conflicts are scoped by supplier", () => {
  for (const event of ["Campanha", "Camp. Promotor"]) {
    assert.notEqual(
      buildPaymentHistoryKey(record(event, "Bombril")),
      buildPaymentHistoryKey(record(event, "JDE"))
    );
    assert.equal(
      buildPaymentHistoryKey(record(event, "JDE")),
      buildPaymentHistoryKey(record(event.toLowerCase(), "jde"))
    );
  }
});

test("other payment events keep the event, person and period conflict rule", () => {
  assert.equal(
    buildPaymentHistoryKey(record("Perfomance", "Omega")),
    buildPaymentHistoryKey(record("Perfomance", "Outro fornecedor"))
  );
});

test("consideration records remain exempt from conflict detection", () => {
  assert.equal(buildPaymentHistoryKey(record("Consideração", "Omega")), null);
});
