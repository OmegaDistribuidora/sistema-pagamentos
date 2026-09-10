import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { env } from "../config";

sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 20 });

export const MAX_PDF_PAGES = 100;
export const MAX_PDF_PAGES_PER_REQUEST = 200;
const PREVIEW_WIDTH = 1600;
const WEBP_QUALITY = 82;
const PROCESS_TIMEOUT_MS = 60_000;
const PREVIEW_ROOT_NAME = "acordos-comerciais-previews";

export class PdfPreviewError extends Error {
  constructor(message: string, public readonly statusCode = 422) {
    super(message);
    this.name = "PdfPreviewError";
  }
}

type PdfAttachment = {
  originalFileName: string;
  mimeType: string;
  storagePath: string;
  biAccessToken: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

let previewQueue: Promise<void> = Promise.resolve();

function runSequentially<T>(task: () => Promise<T>): Promise<T> {
  const result = previewQueue.then(task, task);
  previewQueue = result.then(() => undefined, () => undefined);
  return result;
}

function runCommand(command: string, args: string[], timeoutMs = PROCESS_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const appendLimited = (current: string, chunk: Buffer) => `${current}${chunk.toString("utf8")}`.slice(-32_768);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new PdfPreviewError("O processamento do PDF ultrapassou o tempo de segurança permitido."));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendLimited(stderr, chunk); });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new PdfPreviewError("O conversor de PDFs não está disponível no servidor.", 503));
        return;
      }
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${command} finalizou com código ${code}.`), { stdout, stderr, exitCode: code }));
    });
  });
}

function isPdfMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase() === "application/pdf";
}

function previewRoot(): string {
  return path.join(env.uploadsDir, PREVIEW_ROOT_NAME);
}

function assertSafeToken(token: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error("Token de preview inválido.");
  }
}

export function resolveCommercialAgreementPreviewDirectory(token: string): string {
  assertSafeToken(token);
  return path.join(previewRoot(), token);
}

export function resolveCommercialAgreementPreviewPath(token: string, page: number): string {
  assertSafeToken(token);
  if (!Number.isInteger(page) || page <= 0) throw new Error("Página de preview inválida.");
  return path.join(resolveCommercialAgreementPreviewDirectory(token), `page-${page}.webp`);
}

export function removeCommercialAgreementPreviews(token: string | null | undefined): void {
  if (!token) return;
  const directory = resolveCommercialAgreementPreviewDirectory(token);
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
}

async function hasPdfSignature(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const signature = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return signature.subarray(0, bytesRead).includes(Buffer.from("%PDF-", "ascii"));
  } finally {
    await handle.close();
  }
}

export function parsePdfPageCount(output: string): number | null {
  const match = output.match(/^Pages:\s*(\d+)\s*$/im);
  if (!match) return null;
  const pages = Number(match[1]);
  return Number.isInteger(pages) && pages > 0 ? pages : null;
}

async function inspectPdf(attachment: PdfAttachment): Promise<number> {
  const absolutePath = path.join(env.uploadsDir, attachment.storagePath);
  if (!(await hasPdfSignature(absolutePath))) {
    throw new PdfPreviewError(`O arquivo "${attachment.originalFileName}" não possui uma estrutura PDF válida.`);
  }

  let result: CommandResult;
  try {
    result = await runCommand("pdfinfo", [absolutePath]);
  } catch (error: any) {
    if (error instanceof PdfPreviewError) throw error;
    const details = `${error?.stdout || ""}\n${error?.stderr || ""}`;
    if (/password|encrypted|senha|criptograf/i.test(details)) {
      throw new PdfPreviewError(`O PDF "${attachment.originalFileName}" é protegido por senha. Envie um arquivo sem proteção.`);
    }
    throw new PdfPreviewError(`O PDF "${attachment.originalFileName}" está corrompido ou possui um formato inválido.`);
  }

  if (/^Encrypted:\s*yes\b/im.test(result.stdout)) {
    throw new PdfPreviewError(`O PDF "${attachment.originalFileName}" é protegido por senha. Envie um arquivo sem proteção.`);
  }

  const pages = parsePdfPageCount(result.stdout);
  if (!pages) {
    throw new PdfPreviewError(`Não foi possível identificar as páginas do PDF "${attachment.originalFileName}".`);
  }
  if (pages > MAX_PDF_PAGES) {
    throw new PdfPreviewError(`O PDF "${attachment.originalFileName}" possui ${pages} páginas. O limite é de ${MAX_PDF_PAGES} páginas por arquivo.`);
  }
  return pages;
}

async function renderPdf(attachment: PdfAttachment, totalPages: number): Promise<void> {
  const sourcePath = path.join(env.uploadsDir, attachment.storagePath);
  const finalDirectory = resolveCommercialAgreementPreviewDirectory(attachment.biAccessToken);
  const temporaryDirectory = path.join(previewRoot(), `.${attachment.biAccessToken}-${randomUUID()}.tmp`);
  await fs.promises.mkdir(temporaryDirectory, { recursive: true });

  try {
    for (let page = 1; page <= totalPages; page += 1) {
      const rasterBase = path.join(temporaryDirectory, `raster-${page}`);
      const pngPath = `${rasterBase}.png`;
      try {
        await runCommand("pdftocairo", [
          "-png",
          "-singlefile",
          "-f", String(page),
          "-l", String(page),
          "-scale-to-x", String(PREVIEW_WIDTH),
          "-scale-to-y", "-1",
          sourcePath,
          rasterBase
        ]);
        if (!fs.existsSync(pngPath)) throw new Error("A página renderizada não foi criada.");
        await sharp(pngPath, { limitInputPixels: 40_000_000 })
          .webp({ quality: WEBP_QUALITY, effort: 4, smartSubsample: true, preset: "text" })
          .toFile(path.join(temporaryDirectory, `page-${page}.webp`));
      } catch (error) {
        if (error instanceof PdfPreviewError && error.statusCode === 503) throw error;
        throw new PdfPreviewError(`Não foi possível converter a página ${page} do PDF "${attachment.originalFileName}". O arquivo pode estar corrompido, protegido ou usar recursos incompatíveis.`);
      } finally {
        await fs.promises.rm(pngPath, { force: true }).catch(() => undefined);
      }
    }

    await fs.promises.mkdir(previewRoot(), { recursive: true });
    if (fs.existsSync(finalDirectory)) await fs.promises.rm(finalDirectory, { recursive: true, force: true });
    await fs.promises.rename(temporaryDirectory, finalDirectory);
  } catch (error) {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function generateCommercialAgreementPdfPreviews<T extends PdfAttachment>(attachments: T[]): Promise<Map<string, number>> {
  const pdfs = attachments.filter((attachment) => isPdfMimeType(attachment.mimeType));
  if (!pdfs.length) return new Map();

  return runSequentially(async () => {
    const inspected: Array<{ attachment: T; pages: number }> = [];
    let requestPages = 0;
    for (const attachment of pdfs) {
      const pages = await inspectPdf(attachment);
      requestPages += pages;
      if (requestPages > MAX_PDF_PAGES_PER_REQUEST) {
        throw new PdfPreviewError(`Os PDFs enviados somam mais de ${MAX_PDF_PAGES_PER_REQUEST} páginas. Divida o envio em solicitações menores.`);
      }
      inspected.push({ attachment, pages });
    }

    const totals = new Map<string, number>();
    for (const item of inspected) {
      await renderPdf(item.attachment, item.pages);
      totals.set(item.attachment.biAccessToken, item.pages);
    }
    return totals;
  });
}

export async function ensurePdfPreviewToolsAvailable(): Promise<void> {
  await Promise.all([
    runCommand("pdfinfo", ["-v"], 10_000),
    runCommand("pdftocairo", ["-v"], 10_000)
  ]);
}
