// OpenAI-compatible video submission, polling, downloads and response parsing.
import { videoContentEndpoint, videoStatusEndpoint, videosEndpoint, type Text2VideoConfig } from "../../config.ts";
import { request, type HttpResponse } from "../../http.ts";
import { proxyForUrl, resolveProxySettings } from "../../proxy-env.ts";
import { extFor, videoMimeType } from "../media.ts";
import type { GeneratedVideo, GenerateVideoOptions } from "../types.ts";

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

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Turn a transport failure into one sentence the caller can act on. */
function describeFailure(err: unknown, config: Text2VideoConfig, userSignal: AbortSignal | undefined): Error {
  const reason = err instanceof Error ? err.message : String(err);
  if (userSignal?.aborted || reason === "cancelled") return new Error("cancelled");
  if (/timed out/.test(reason)) {
    return new Error(`videos API timed out after ${Math.round(config.timeoutMs / 1000)}s. Raise timeoutMs in the text2video config.`);
  }
  return new Error(`cannot reach ${videosEndpoint(config)}: ${reason}`);
}

async function assertOk(res: HttpResponse, config: Text2VideoConfig): Promise<void> {
  if (res.status >= 200 && res.status < 300) return;
  const body = await res.text().catch(() => "");
  const unauthorized = res.status === 401 || res.status === 403;
  const hint = unauthorized
    ? ` — check apiKey (text2video config or PI_TEXT2VIDEO_API_KEY)${config.codexHint ? `\n${config.codexHint}` : ""}`
    : res.status === 404
      ? ` — check baseUrl; the endpoint resolved to ${videosEndpoint(config)}`
      : "";
  throw new Error(`videos API returned ${res.status} ${res.statusText}${hint}\n${preview(body)}`);
}

async function sendJson(url: string, body: unknown, config: Text2VideoConfig, signal: AbortSignal | undefined): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json", ...config.headers };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  let res: HttpResponse;
  try {
    res = await request(url, { method: "POST", headers, body: JSON.stringify(body), signal, timeoutMs: config.timeoutMs, proxy: proxyFor(url) });
  } catch (err) {
    throw describeFailure(err, config, signal);
  }
  await assertOk(res, config);
  // Read once: a failed JSON.parse already drained the stream.
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the videos API returned a body that is not JSON: ${preview(text)}`);
  }
}

async function getJson(url: string, config: Text2VideoConfig, signal: AbortSignal | undefined): Promise<any> {
  let res: HttpResponse;
  try {
    res = await request(url, { headers: config.headers, signal, timeoutMs: config.timeoutMs, proxy: proxyFor(url) });
  } catch (err) {
    throw describeFailure(err, config, signal);
  }
  await assertOk(res, config);
  return res.json().catch(() => undefined);
}

// --- job shapes ------------------------------------------------------------

const RUNNING = /^(queued|pending|created|submitted|accepted|in[_-]?progress|processing|running|started|waiting)$/;
const DONE = /^(completed|complete|succeeded|success|finished|done|ready)$/;
const FAILED = /^(failed|failure|error|cancelled|canceled|expired|rejected)$/;

function jobIdOf(json: any): string | undefined {
  const candidates = [json?.id, json?.task_id, json?.taskId, json?.job_id, json?.jobId, json?.request_id, json?.requestId, json?.data?.id, json?.result?.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function statusOf(json: any): string | undefined {
  const candidates = [json?.status, json?.state, json?.task_status, json?.data?.status, json?.result?.status, json?.output?.task_status];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate.toLowerCase();
  }
  return undefined;
}

/** Items that describe media, not the job around them. */
function mediaItems(json: any): unknown[] {
  const candidates = [json?.data, json?.videos, json?.results, json?.artifacts, json?.output?.results, json?.output?.videos, json?.result?.videos, json?.result?.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

function pickUrl(value: any): string | undefined {
  const candidates = [
    value?.url,
    value?.video_url,
    value?.videoUrl,
    value?.content_url,
    value?.contentUrl,
    value?.download_url,
    value?.downloadUrl,
    value?.output?.url,
    value?.data?.url,
    value?.result?.url,
    value?.video?.url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && (isHttpUrl(candidate) || candidate.startsWith("data:"))) return candidate;
  }
  return undefined;
}

function pickBase64(value: any): string | undefined {
  const candidates = [value?.b64_json, value?.b64, value?.base64, value?.video_base64, value?.videoBase64];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  for (const candidate of [value?.video, value?.data]) {
    if (typeof candidate === "string" && candidate.length > 0 && !isHttpUrl(candidate) && !candidate.startsWith("data:")) return candidate;
  }
  return undefined;
}

function fromBytes(data: Buffer): GeneratedVideo {
  if (data.byteLength === 0) throw new Error("the videos API returned zero bytes");
  const mimeType = videoMimeType(data) ?? "video/mp4";
  return { data, mimeType, ext: extFor(mimeType) };
}

function fromBase64(base64: string): GeneratedVideo {
  const cleaned = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
  return fromBytes(Buffer.from(cleaned, "base64"));
}

async function download(url: string, config: Text2VideoConfig, signal: AbortSignal | undefined): Promise<GeneratedVideo> {
  if (url.startsWith("data:")) return fromBase64(url);
  let res: HttpResponse;
  try {
    res = await request(url, { signal, timeoutMs: config.timeoutMs, proxy: proxyFor(url) });
  } catch (err) {
    throw describeFailure(err, config, signal);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`video download failed ${res.status} ${res.statusText}: ${url}`);
  const data = await res.buffer();
  const contentType = res.headers["content-type"];
  const sniffed = videoMimeType(data) ?? (typeof contentType === "string" ? contentType.split(";")[0]?.trim() : undefined);
  const mimeType = sniffed && sniffed.startsWith("video/") ? sniffed : "video/mp4";
  return { data, mimeType, ext: extFor(mimeType) };
}

async function resolveItem(item: unknown, config: Text2VideoConfig, signal: AbortSignal | undefined): Promise<GeneratedVideo> {
  if (typeof item === "string") return isHttpUrl(item) || item.startsWith("data:") ? download(item, config, signal) : fromBase64(item);
  const base64 = pickBase64(item);
  if (base64) return fromBase64(base64);
  const url = pickUrl(item);
  if (url) return download(url, config, signal);
  throw new Error(`unrecognised video response item: ${preview(item, 200)}`);
}

/** Poll the job until it finishes, then turn the terminal payload into bytes. */
async function awaitJob(id: string, initial: any, config: Text2VideoConfig, options: GenerateVideoOptions): Promise<GeneratedVideo[]> {
  const named = [initial?.status_url, initial?.statusUrl, initial?.polling_url, initial?.pollingUrl].find((value) => typeof value === "string" && isHttpUrl(value));
  const statusUrl = typeof named === "string" ? named : videoStatusEndpoint(config, id);
  const deadline = Date.now() + config.pollTimeoutMs;
  let payload = initial;

  for (;;) {
    const status = statusOf(payload) ?? "";
    if (DONE.test(status)) break;
    if (FAILED.test(status)) throw new Error(`the video job ${id} ${status}: ${preview(payload)}`);
    if (Date.now() >= deadline) {
      throw new Error(
        `the video job ${id} was still ${status || "unfinished"} after ${Math.round(config.pollTimeoutMs / 1000)}s — ` +
          `raise pollTimeoutMs in the text2video config, or check ${statusUrl} later.`,
      );
    }
    const progress = typeof payload?.progress === "number" ? ` (${Math.round(payload.progress)}%)` : "";
    options.onProgress?.(`video job ${id}: ${status || "waiting"}${progress}`);
    await sleep(config.pollIntervalMs, options.signal);
    payload = await getJson(statusUrl, config, options.signal);
  }

  const items = mediaItems(payload);
  if (items.length > 0) return Promise.all(items.map((item) => resolveItem(item, config, options.signal)));
  const url = pickUrl(payload);
  if (url) return [await download(url, config, options.signal)];
  // OpenAI's shape: the job description carries no URL, the bytes are separate.
  return [await download(videoContentEndpoint(config, id), config, options.signal)];
}

export async function generateWithOpenAI(options: GenerateVideoOptions): Promise<GeneratedVideo[]> {
  const { config } = options;
  const model = options.model?.trim() || config.model;
  const size = options.size?.trim() || config.size;
  const seconds = options.seconds?.trim() || config.seconds;

  const body: Record<string, unknown> = { ...config.extraBody, model, prompt: options.prompt };
  if (size) body.size = size;
  if (seconds) body.seconds = seconds;
  if (config.responseFormat) body.response_format = config.responseFormat;

  const submitted: any = await sendJson(videosEndpoint(config), body, config, options.signal);

  // A service may answer synchronously with the media already in hand.
  const items = mediaItems(submitted);
  if (items.length > 0) return Promise.all(items.map((item) => resolveItem(item, config, options.signal)));
  if (pickUrl(submitted) || pickBase64(submitted)) return [await resolveItem(submitted, config, options.signal)];

  const id = jobIdOf(submitted);
  if (!id) throw new Error(`no video and no job id in the videos API response: ${preview(submitted)}`);

  const status = statusOf(submitted) ?? "";
  if (FAILED.test(status)) throw new Error(`the video job ${id} ${status}: ${preview(submitted)}`);
  if (DONE.test(status)) {
    const finishedItems = mediaItems(submitted);
    if (finishedItems.length > 0) return Promise.all(finishedItems.map((item) => resolveItem(item, config, options.signal)));
    const url = pickUrl(submitted);
    return [url ? await download(url, config, options.signal) : await download(videoContentEndpoint(config, id), config, options.signal)];
  }
  if (status && !RUNNING.test(status)) {
    // Unknown state: poll it anyway rather than giving up on a vocabulary we did not predict.
    options.onProgress?.(`video job ${id}: ${status} (unrecognised status, polling anyway)`);
  }
  return awaitJob(id, submitted, config, options);
}
