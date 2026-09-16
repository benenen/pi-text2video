// Client for the OpenAI-compatible images API, plus saving to disk.
//
// Response shapes differ between vendors: OpenAI returns {data:[{b64_json|url}]},
// SiliconFlow {images:[{url}]}, and DashScope's compatibility mode wraps the list
// in output.results. Parsing is deliberately lenient so switching providers does
// not mean editing code; when nothing can be extracted, a slice of the raw body
// goes into the error so the response can be inspected.

import * as fs from "node:fs";
import * as path from "node:path";

import { generateImagesViaCodexApi } from "./codex-api.ts";
import { generateImagesWithCodex } from "./codex-backend.ts";
import { imagesEndpoint, type Text2ImageConfig } from "./config.ts";
import { request, type HttpResponse } from "./http.ts";
import { proxyForUrl, resolveProxySettings } from "./proxy-env.ts";

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  ext: string;
  /** Actual pixels, read from the file header. Absent for formats we cannot parse. */
  width?: number;
  height?: number;
  /** Some services (DALL·E 3 for one) return the prompt they actually used. */
  revisedPrompt?: string;
}

export interface SavedImage {
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  revisedPrompt?: string;
}

export interface GenerateOptions {
  config: Text2ImageConfig;
  prompt: string;
  n?: number;
  size?: string;
  model?: string;
  signal?: AbortSignal;
}

const MIME_BY_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function extFor(mimeType: string): string {
  return MIME_BY_EXT[mimeType] ?? "png";
}

/** Sniff by magic bytes: servers often label image bytes application/octet-stream. */
function sniffMime(buffer: Buffer): string | undefined {
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

function preview(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "(empty)";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function proxyFor(url: string): URL | undefined {
  return proxyForUrl(new URL(url), resolveProxySettings());
}

/** Turn a transport failure into one sentence the caller can act on. */
function describeFailure(err: unknown, config: Text2ImageConfig, userSignal: AbortSignal | undefined): Error {
  const reason = err instanceof Error ? err.message : String(err);
  if (userSignal?.aborted || reason === "cancelled") return new Error("cancelled");
  if (/timed out/.test(reason)) {
    return new Error(`images API timed out after ${Math.round(config.timeoutMs / 1000)}s. Image generation is slow by nature — raise timeoutMs in the config.`);
  }
  return new Error(`cannot reach ${imagesEndpoint(config)}: ${reason}`);
}

async function assertOk(res: HttpResponse, config: Text2ImageConfig): Promise<void> {
  if (res.status >= 200 && res.status < 300) return;
  const body = await res.text().catch(() => "");
  const unauthorized = res.status === 401 || res.status === 403;
  const hint =
    unauthorized
      ? ` — check apiKey (config file or PI_TEXT2IMAGE_API_KEY)${config.codexHint ? `\n${config.codexHint}` : ""}`
      : res.status === 404
        ? ` — check baseUrl; the endpoint resolved to ${imagesEndpoint(config)}`
        : "";
  throw new Error(`images API returned ${res.status} ${res.statusText}${hint}\n${preview(body)}`);
}

function collectItems(json: any): unknown[] {
  const candidates = [json?.data, json?.images, json?.output?.results, json?.result?.images, json?.artifacts];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

function pickBase64(item: any): string | undefined {
  const candidates = [item?.b64_json, item?.b64, item?.base64, item?.image_base64, item?.imageBase64];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  // image / data may hold base64 or a URL, so the content decides.
  for (const candidate of [item?.image, item?.data]) {
    if (typeof candidate === "string" && candidate.length > 0 && !isHttpUrl(candidate)) return candidate;
  }
  return undefined;
}

function pickUrl(item: any): string | undefined {
  const candidates = [item?.url, item?.image_url?.url, item?.image_url, item?.image, item?.data];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && (isHttpUrl(candidate) || candidate.startsWith("data:"))) return candidate;
  }
  return undefined;
}

function fromBase64(base64: string, revisedPrompt?: string): GeneratedImage {
  const cleaned = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const data = Buffer.from(cleaned, "base64");
  if (data.byteLength === 0) throw new Error("the returned base64 decoded to nothing");
  const mimeType = sniffMime(data) ?? "image/png";
  return { data, mimeType, ext: extFor(mimeType), ...imageDimensions(data), revisedPrompt };
}

async function download(url: string, timeoutMs: number, signal: AbortSignal | undefined, revisedPrompt?: string): Promise<GeneratedImage> {
  if (url.startsWith("data:")) return fromBase64(url, revisedPrompt);
  const res = await request(url, { signal, timeoutMs, proxy: proxyFor(url) });
  if (res.status < 200 || res.status >= 300) throw new Error(`image download failed ${res.status} ${res.statusText}: ${url}`);
  const data = await res.buffer();
  const contentType = res.headers["content-type"];
  const mimeType = sniffMime(data) ?? (typeof contentType === "string" ? contentType.split(";")[0]?.trim() : undefined) ?? "image/png";
  return { data, mimeType, ext: extFor(mimeType), ...imageDimensions(data), revisedPrompt };
}

async function generateWithOpenAI(options: GenerateOptions): Promise<GeneratedImage[]> {
  const { config, prompt } = options;
  const model = options.model?.trim() || config.model;
  const n = Math.min(Math.max(options.n ?? 1, 1), 10);
  const size = options.size?.trim() || config.size;

  const body: Record<string, unknown> = { ...config.extraBody, model, prompt, n };
  if (size) body.size = size;
  if (config.responseFormat) body.response_format = config.responseFormat;

  const headers: Record<string, string> = { "content-type": "application/json", ...config.headers };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const endpoint = imagesEndpoint(config);
  let res: HttpResponse;
  try {
    res = await request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
      timeoutMs: config.timeoutMs,
      proxy: proxyFor(endpoint),
    });
  } catch (err) {
    throw describeFailure(err, config, options.signal);
  }
  await assertOk(res, config);

  const json = await res.json().catch(() => undefined);
  const items = collectItems(json);
  if (items.length === 0) throw new Error(`no image in the images API response: ${preview(json)}`);

  const images: GeneratedImage[] = [];
  for (const item of items) {
    const revisedPrompt = typeof (item as any)?.revised_prompt === "string" ? (item as any).revised_prompt : undefined;
    const base64 = typeof item === "string" && !isHttpUrl(item) && !item.startsWith("data:") ? item : pickBase64(item);
    const url = typeof item === "string" ? (isHttpUrl(item) || item.startsWith("data:") ? item : undefined) : pickUrl(item);
    try {
      if (base64) images.push(fromBase64(base64, revisedPrompt));
      else if (url) images.push(await download(url, config.timeoutMs, options.signal, revisedPrompt));
      else throw new Error(`unrecognised response item: ${preview(item, 200)}`);
    } catch (err) {
      if (err instanceof Error && /cancelled|timed out/.test(err.message)) throw describeFailure(err, config, options.signal);
      throw err;
    }
  }
  return images;
}

function imageFromFile(file: string): GeneratedImage {
  const data = fs.readFileSync(file);
  const mimeType = sniffMime(data) ?? "image/png";
  return { data, mimeType, ext: extFor(mimeType), ...imageDimensions(data) };
}

/** Dispatches to the configured backend; both return images in memory, unsaved. */
export async function generateImages(options: GenerateOptions): Promise<GeneratedImage[]> {
  const { config } = options;
  if (config.provider !== "codex") return generateWithOpenAI(options);

  const n = Math.min(Math.max(options.n ?? 1, 1), 10);
  const size = options.size?.trim() || config.size;

  if (config.codexMode === "api") {
    const results = await generateImagesViaCodexApi({ config, prompt: options.prompt, n, size, signal: options.signal });
    return results.map((result) => fromBase64(result.base64, result.revisedPrompt));
  }

  const files = await generateImagesWithCodex({ config, prompt: options.prompt, n, size, signal: options.signal });
  return files.map(imageFromFile);
}

function slugify(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned.slice(0, 40).replace(/-+$/, "") || "image");
}

function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function uniquePath(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}-${i}.${ext}`);
  return candidate;
}

export function saveImages(images: GeneratedImage[], options: { outputDir: string; prompt: string; filename?: string }): SavedImage[] {
  fs.mkdirSync(options.outputDir, { recursive: true });
  const stamp = timestamp();
  const slug = slugify(options.filename?.trim() || options.prompt);
  return images.map((image, index) => {
    const suffix = images.length > 1 ? `-${index + 1}` : "";
    const file = uniquePath(options.outputDir, `${stamp}-${slug}${suffix}`, image.ext);
    fs.writeFileSync(file, image.data);
    return {
      path: file,
      mimeType: image.mimeType,
      bytes: image.data.byteLength,
      width: image.width,
      height: image.height,
      revisedPrompt: image.revisedPrompt,
    };
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
