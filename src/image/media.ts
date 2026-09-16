import * as fs from "node:fs";
import type { GeneratedImage } from "./types.ts";

const MIME_BY_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function extFor(mimeType: string): string {
  return MIME_BY_EXT[mimeType] ?? "png";
}

/** Sniff by magic bytes: servers often label image bytes application/octet-stream. */
export function sniffMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

/**
 * Pixel dimensions from the header. The requested `size` is a request, not a
 * promise — the codex backend picks its own, and OpenAI-compatible services
 * round or ignore it — so anything shown to the user comes from here instead.
 */
export function imageDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  try {
    if (buffer.length >= 24 && buffer.subarray(12, 16).toString("ascii") === "IHDR") {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length >= 10 && buffer.subarray(0, 4).toString("ascii") === "GIF8") {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
      const chunk = buffer.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X") return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
      if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      // Walk the segment chain to the first start-of-frame, which carries the size.
      for (let offset = 2; offset + 9 < buffer.length; ) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {
    // Truncated or malformed header: the size simply goes unreported.
  }
  return undefined;
}

export function fromBase64(base64: string, revisedPrompt?: string): GeneratedImage {
  const cleaned = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const data = Buffer.from(cleaned, "base64");
  if (data.byteLength === 0) throw new Error("the returned base64 decoded to nothing");
  const mimeType = sniffMime(data) ?? "image/png";
  return { data, mimeType, ext: extFor(mimeType), ...imageDimensions(data), revisedPrompt };
}

export function imageFromFile(file: string): GeneratedImage {
  const data = fs.readFileSync(file);
  const mimeType = sniffMime(data) ?? "image/png";
  return { data, mimeType, ext: extFor(mimeType), ...imageDimensions(data) };
}
