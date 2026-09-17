// MiniMax image-01: one synchronous generation request, then optional downloads.
import { imagesEndpoint } from "../../config.ts";
import { request } from "../../http.ts";
import { proxyForUrl, resolveProxySettings } from "../../proxy-env.ts";
import { fromBase64, sniffMime, extFor, imageDimensions } from "../media.ts";
import type { GenerateOptions, GeneratedImage } from "../types.ts";

const RATIOS = ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"];

function requestBody(options: GenerateOptions): Record<string, unknown> {
  const { config, prompt } = options;
  const n = options.n ?? 1;
  if (!prompt.trim() || [...prompt].length > 1500) throw new Error("MiniMax image prompt must contain 1–1500 characters");
  if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error("MiniMax image count must be an integer from 1 to 9");
  const body: Record<string, unknown> = {
    prompt_optimizer: false,
    ...config.extraBody,
    model: options.model?.trim() || config.model,
    prompt,
    n,
    response_format: config.responseFormat ?? config.extraBody.response_format ?? "base64",
  };
  const size = options.size?.trim() || config.size;
  if (size) {
    delete body.aspect_ratio;
    delete body.width;
    delete body.height;
    if (RATIOS.includes(size)) body.aspect_ratio = size;
    else {
      const match = size.match(/^(\d+)x(\d+)$/);
      if (!match) throw new Error("MiniMax image size must be an aspect ratio (16:9) or dimensions (1024x1024)");
      body.width = Number(match[1]);
      body.height = Number(match[2]);
    }
  }
  if (body.aspect_ratio !== undefined && !RATIOS.includes(String(body.aspect_ratio))) throw new Error("Unsupported MiniMax image aspect_ratio");
  if (body.width !== undefined || body.height !== undefined) {
    for (const dimension of [body.width, body.height]) {
      if (typeof dimension !== "number" || !Number.isInteger(dimension) || dimension < 512 || dimension > 2048 || dimension % 8 !== 0) {
        throw new Error("MiniMax image width and height must both be multiples of 8 from 512 to 2048");
      }
    }
  }
  if (!["base64", "url"].includes(String(body.response_format))) throw new Error("MiniMax image responseFormat must be base64 or url");
  return body;
}

export async function generateWithMiniMax(options: GenerateOptions): Promise<GeneratedImage[]> {
  const { config } = options;
  if (!config.apiKey || config.apiKey === "codex") throw new Error("MiniMax images require MINIMAX_API_KEY or text2image apiKey");
  const body = requestBody(options);
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const proxy = resolveProxySettings();
  const read = async (url: string, authenticated = false): Promise<Buffer> => {
    const response = await request(url, {
      method: authenticated ? "POST" : "GET",
      headers: authenticated ? { ...config.headers, "content-type": "application/json", authorization: `Bearer ${config.apiKey}` } : undefined,
      body: authenticated ? JSON.stringify(body) : undefined,
      signal, timeoutMs: config.timeoutMs, proxy: proxyForUrl(new URL(url), proxy),
    });
    const pending = response.buffer();
    const abort = () => response.stream.destroy(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const data = await pending;
      if (response.status < 200 || response.status >= 300) throw new Error(`MiniMax image request failed ${response.status}: ${data.toString("utf-8").slice(0, 400)}`);
      return data;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  try {
    const raw = await read(imagesEndpoint(config), true);
    let payload;
    try { payload = JSON.parse(raw.toString("utf-8")); }
    catch { throw new Error("MiniMax image API returned invalid JSON"); }
    if (payload?.base_resp?.status_code !== undefined && payload.base_resp.status_code !== 0) {
      throw new Error(`MiniMax image API error ${payload.base_resp.status_code}: ${payload.base_resp.status_msg}`);
    }
    const base64 = payload?.data?.image_base64;
    if (Array.isArray(base64) && base64.length) return base64.map((value: string) => fromBase64(value));
    const urls = payload?.data?.image_urls;
    if (!Array.isArray(urls) || !urls.length) throw new Error("MiniMax image API returned no images");
    const images: GeneratedImage[] = [];
    for (const url of urls) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("MiniMax image API returned an invalid image URL");
      const data = await read(url);
      const mimeType = sniffMime(data);
      if (!mimeType) throw new Error("MiniMax image download returned unrecognised image data");
      images.push({ data, mimeType, ext: extFor(mimeType), ...imageDimensions(data) });
    }
    return images;
  } catch (error) {
    if (options.signal?.aborted) throw new Error("cancelled");
    if (deadline.aborted) throw new Error(`MiniMax image request timed out after ${config.timeoutMs}ms`);
    throw error;
  }
}
