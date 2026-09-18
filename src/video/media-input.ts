// Resolve explicit MiniMax media inputs; local files are sent as data URLs.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveOutputDir } from "../config.ts";
import { sniffMime } from "../image/media.ts";

export type VideoMediaKind = "image" | "video" | "audio";
const MEDIA_LIMITS = {
  image: { megabytes: 30, types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] },
  video: { megabytes: 50, types: ["video/mp4", "video/quicktime"] },
  audio: { megabytes: 15, types: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"] },
};

export async function resolveVideoMedia(input: string, kind: VideoMediaKind, cwd: string, signal?: AbortSignal): Promise<string> {
  const { megabytes, types } = MEDIA_LIMITS[kind];
  const maxBytes = megabytes * 1024 * 1024;
  if (signal?.aborted) throw new Error("cancelled");
  const value = input.trim();
  if (!value) throw new Error(`${kind} input must not be empty`);
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!url.hostname) throw new Error(`${kind} URL must have a hostname`);
    return value;
  }
  if (value.startsWith("data:")) {
    const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new Error(`${kind} data URL must contain valid base64`);
    if (!types.includes(match[1])) throw new Error(`unsupported ${kind} format; use ${types.join(", ")}`);
    if (Buffer.byteLength(match[2], "base64") > maxBytes) throw new Error(`${kind} exceeds the ${megabytes} MB limit`);
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
      throw new Error(`${kind} data URL must contain valid base64`);
    }
    return value;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error(`${kind} URL protocol must be HTTP, HTTPS or an ${kind} data URL`);

  const file = resolveOutputDir(cwd, value);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${kind} path must point to a file`);
  if (stat.size > maxBytes) throw new Error(`${kind} exceeds the ${megabytes} MB limit`);
  const bytes = await fs.readFile(file, { signal });
  if (!bytes.length) throw new Error(`${kind} file is empty`);
  if (bytes.length > maxBytes) throw new Error(`${kind} exceeds the ${megabytes} MB limit`);
  const suffix = path.extname(file).toLowerCase();
  let mimeType: string | undefined;
  if (kind === "image") {
    mimeType = sniffMime(bytes) ?? (suffix === ".heic" ? "image/heic" : suffix === ".heif" ? "image/heif" : undefined);
  } else if (kind === "video" && bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    mimeType = suffix === ".mov" ? "video/quicktime" : "video/mp4";
  } else if (kind === "audio") {
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") mimeType = "audio/wav";
    else if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) mimeType = "audio/mpeg";
  }
  if (!mimeType || !types.includes(mimeType)) throw new Error(`unsupported ${kind} format; use ${types.join(", ")}`);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}
