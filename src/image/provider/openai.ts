// OpenAI-compatible image requests, downloads and vendor response parsing.
import { imagesEndpoint, type Text2ImageConfig } from "../../config.ts";
import { request, type HttpResponse } from "../../http.ts";
import { proxyForUrl, resolveProxySettings } from "../../proxy-env.ts";
import { extFor, sniffMime, fromBase64, imageDimensions } from "../media.ts";
import type { GeneratedImage, GenerateOptions } from "../types.ts";

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

async function download(url: string, timeoutMs: number, signal: AbortSignal | undefined, revisedPrompt?: string): Promise<GeneratedImage> {
  if (url.startsWith("data:")) return fromBase64(url, revisedPrompt);
  const res = await request(url, { signal, timeoutMs, proxy: proxyFor(url) });
  if (res.status < 200 || res.status >= 300) throw new Error(`image download failed ${res.status} ${res.statusText}: ${url}`);
  const data = await res.buffer();
  const contentType = res.headers["content-type"];
  const mimeType = sniffMime(data) ?? (typeof contentType === "string" ? contentType.split(";")[0]?.trim() : undefined) ?? "image/png";
  return { data, mimeType, ext: extFor(mimeType), ...imageDimensions(data), revisedPrompt };
}

export async function generateWithOpenAI(options: GenerateOptions): Promise<GeneratedImage[]> {
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
