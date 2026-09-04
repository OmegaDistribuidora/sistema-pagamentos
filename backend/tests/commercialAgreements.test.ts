import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCommercialAgreementPayload,
  requiredAttachmentCategories
} from "../src/lib/commercialAgreements";

function basePayload() {
  return {
    audienceType: "NETWORK",
    networkCode: 100,
    clientCodes: [],
    agreementType: "LOYALTY",
    otherDescription: "",
    totalAmount: 1000,
    splitAmount: false,
    suppliers: [{ supplierCode: 117 }],
    productCodes: [],
    notes: ""
  };
}

test("normalizes a single supplier with the full agreement amount", () => {
  const parsed = parseCommercialAgreementPayload(basePayload());

  assert.equal(parsed.totalAmount, 1000);
  assert.deepEqual(parsed.suppliers, [{ supplierCode: 117, allocatedAmount: 1000 }]);
  assert.equal(parsed.networkCode, 100);
  assert.deepEqual(parsed.clientCodes, []);
});

test("accepts an exact split between multiple suppliers", () => {
  const parsed = parseCommercialAgreementPayload({
    ...basePayload(),
    audienceType: "SPECIFIC_CLIENTS",
    networkCode: null,
    clientCodes: [10, 20],
    totalAmount: 2000,
    splitAmount: true,
    suppliers: [
      { supplierCode: 117, allocatedAmount: 500 },
      { supplierCode: 3609, allocatedAmount: 1000 },
      { supplierCode: 4698, allocatedAmount: 500 }
    ]
  });

  assert.equal(parsed.suppliers.reduce((sum, item) => sum + item.allocatedAmount, 0), 2000);
  assert.deepEqual(parsed.clientCodes, [10, 20]);
  assert.equal(parsed.networkCode, null);
});

test("rejects a split whose sum differs from the total", () => {
  assert.throws(
    () =>
      parseCommercialAgreementPayload({
        ...basePayload(),
        totalAmount: 2000,
        splitAmount: true,
        suppliers: [
          { supplierCode: 117, allocatedAmount: 500 },
          { supplierCode: 3609, allocatedAmount: 1000 }
        ]
      }),
    /soma dos valores rateados/
  );
});

test("requires products for inserts, product registry and extra points", () => {
  for (const agreementType of ["INSERT", "PRODUCT_REGISTRY", "EXTRA_POINT"]) {
    assert.throws(
      () => parseCommercialAgreementPayload({ ...basePayload(), agreementType, productCodes: [] }),
      /código de produto/
    );
  }
});

test("requires a description for the Other agreement type", () => {
  assert.throws(
    () => parseCommercialAgreementPayload({ ...basePayload(), agreementType: "OTHER", otherDescription: "" }),
    /Descreva o tipo/
  );
});

test("requires photos except for store outfit agreements", () => {
  assert.deepEqual(requiredAttachmentCategories("LOYALTY"), ["INVOICES", "SALES_REPORT", "PHOTOS"]);
  assert.deepEqual(requiredAttachmentCategories("STORE_OUTFIT"), ["INVOICES", "SALES_REPORT"]);
});
