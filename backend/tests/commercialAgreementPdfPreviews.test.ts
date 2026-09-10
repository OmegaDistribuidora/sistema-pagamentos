import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  parsePdfPageCount,
  resolveCommercialAgreementPreviewPath
} from "../src/lib/commercialAgreementPdfPreviews";

test("reads the page count reported by pdfinfo", () => {
  assert.equal(parsePdfPageCount("Title: Example\nPages:          37\nEncrypted:      no\n"), 37);
  assert.equal(parsePdfPageCount("Pages: 0"), null);
  assert.equal(parsePdfPageCount("Page size: 595 x 842 pts"), null);
});

test("builds a predictable and safe preview path", () => {
  const token = "123e4567-e89b-42d3-a456-426614174000";
  const previewPath = resolveCommercialAgreementPreviewPath(token, 3);
  assert.equal(path.basename(previewPath), "page-3.webp");
  assert.equal(path.basename(path.dirname(previewPath)), token);
  assert.throws(() => resolveCommercialAgreementPreviewPath("../invalid", 1), /Token de preview inválido/);
  assert.throws(() => resolveCommercialAgreementPreviewPath(token, 0), /Página de preview inválida/);
});

test("sharp creates a valid WebP preview file", async () => {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agreement-webp-test-"));
  const targetPath = path.join(temporaryDirectory, "page-1.webp");
  try {
    await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: "white"
      }
    }).webp({ quality: 82 }).toFile(targetPath);
    const metadata = await sharp(targetPath).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 32);
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
