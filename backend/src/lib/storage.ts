import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../config";

export function ensureUploadsDir(): void {
  fs.mkdirSync(env.uploadsDir, { recursive: true });
}

export function sanitizeFileName(value: string): string {
  return String(value || "arquivo")
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function buildStoredFilePath(parts: string[], originalName: string): {
  absolutePath: string;
  relativePath: string;
  fileName: string;
} {
  const safeOriginal = sanitizeFileName(originalName || "arquivo");
  const ext = path.extname(safeOriginal);
  const base = path.basename(safeOriginal, ext) || "arquivo";
  const fileName = `${base}-${randomUUID()}${ext}`;
  const relativePath = path.join(...parts, fileName);
  const absolutePath = path.join(env.uploadsDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  return {
    absolutePath,
    relativePath: relativePath.replace(/\\/g, "/"),
    fileName
  };
}

export function saveBufferToUploads(parts: string[], originalName: string, buffer: Buffer) {
  const target = buildStoredFilePath(parts, originalName);
  fs.writeFileSync(target.absolutePath, buffer);
  return target;
}

export async function saveStreamToUploads(parts: string[], originalName: string, input: Readable) {
  const target = buildStoredFilePath(parts, originalName);
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      sizeBytes += Buffer.byteLength(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(input, counter, fs.createWriteStream(target.absolutePath, { flags: "wx" }));
    return { ...target, sizeBytes };
  } catch (error) {
    if (fs.existsSync(target.absolutePath)) {
      fs.rmSync(target.absolutePath, { force: true });
    }
    throw error;
  }
}

export function readUpload(relativePath: string): Buffer {
  return fs.readFileSync(path.join(env.uploadsDir, relativePath));
}

export function resolveUpload(relativePath: string): string {
  return path.join(env.uploadsDir, relativePath);
}

export function removeUpload(relativePath: string | null | undefined): void {
  if (!relativePath) {
    return;
  }

  const absolutePath = resolveUpload(relativePath);
  if (fs.existsSync(absolutePath)) {
    fs.rmSync(absolutePath, { force: true });
  }
}
