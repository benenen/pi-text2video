// MiniMax H3 V2: submit text and optional frame images, poll, download the original video.
// https://platform.minimax.io/docs/api-reference/video-generation-v2-create
import { setTimeout as delay } from "node:timers/promises";
import { videosEndpoint, videoStatusEndpoint, type Text2VideoConfig } from "../../config.ts";
import { request } from "../../http.ts";
import { mediaProxySettings, proxyForUrl } from "../../proxy-env.ts";
import { resolveVideoMedia } from "../media-input.ts";
import { extFor, videoMimeType } from "../media.ts";
import type { GeneratedVideo, GenerateVideoOptions } from "../types.ts";

interface MiniMaxResponse {
  task_id?: string;
  type?: string;
  error?: { message?: string };
  task?: { status?: string; content?: { url?: string }; error?: { code?: string | number; message?: string } };
}

function proxyFor(url: string, config: Text2VideoConfig): URL | undefined {
  return proxyForUrl(new URL(url), mediaProxySettings(config));
}

/** Keep deadlines and cancellation active while reading the response body too. */
async function readResponse(url: string, config: Text2VideoConfig, signal: AbortSignal, body?: Record<string, unknown>, authenticated = true): Promise<{ status: number; data: Buffer }> {
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = AbortSignal.any([signal, deadline]);
  try {
    const response = await request(url, {
      method: body ? "POST" : "GET",
      headers: authenticated ? { ...config.headers, "content-type": "application/json", authorization: `Bearer ${config.apiKey}` } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: config.timeoutMs,
      signal: requestSignal,
      proxy: proxyFor(url, config),
    });
    const pending = response.buffer();
    const abort = () => response.stream.destroy(new Error("cancelled"));
    requestSignal.addEventListener("abort", abort, { once: true });
    if (requestSignal.aborted) abort();
    try {
      return { status: response.status, data: await pending };
    } finally {
      requestSignal.removeEventListener("abort", abort);
    }
  } catch (error) {
    if (!signal.aborted && deadline.aborted) throw new Error(`MiniMax request timed out after ${config.timeoutMs}ms`);
    throw error;
  }
}

async function apiRequest(url: string, config: Text2VideoConfig, signal: AbortSignal, body?: Record<string, unknown>): Promise<MiniMaxResponse> {
  const response = await readResponse(url, config, signal, body);
  const text = response.data.toString("utf-8");
  let payload: MiniMaxResponse;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`MiniMax API returned ${response.status}, not JSON: ${text.slice(0, 400)}`);
  }
  if (response.status < 200 || response.status >= 300 || payload?.type === "error" || payload?.error) {
    throw new Error(`MiniMax API returned ${response.status}: ${payload?.error?.message ?? text.slice(0, 400)}`);
  }
  if (!payload || typeof payload !== "object") throw new Error("MiniMax API returned an invalid JSON object");
  return payload;
}

async function requestBody(options: GenerateVideoOptions): Promise<Record<string, unknown>> {
  const { config } = options;
  const model = options.model?.trim() || config.model;
  const resolution = (options.size?.trim() || config.size || "768P").toUpperCase();
  const duration = Number(options.seconds?.trim() || config.seconds || "6");
  const maxVariant = model === "MiniMax-H3-Max";
  const resolutions = maxVariant ? ["480P", "768P"] : ["768P", "2K"];
  if (!resolutions.includes(resolution)) throw new Error(`MiniMax ${model} resolution (--size) must be ${resolutions.join(" or ")}`);
  if (!Number.isInteger(duration) || duration < (maxVariant ? 5 : 4) || duration > 15) {
    throw new Error(`MiniMax ${model} duration (--seconds) must be an integer from ${maxVariant ? 5 : 4} to 15`);
  }
  if (!options.prompt.trim()) throw new Error("MiniMax H3 requires a non-empty prompt");
  const references = [
    { inputs: options.referenceImages ?? [], kind: "image", limit: 9 },
    { inputs: options.referenceVideos ?? [], kind: "video", limit: 3 },
    { inputs: options.referenceAudios ?? [], kind: "audio", limit: 3 },
  ] as const;
  const referenceCount = references.reduce((count, reference) => count + reference.inputs.length, 0);
  const hasFrames = options.firstFrame !== undefined || options.lastFrame !== undefined;
  if (hasFrames && referenceCount) throw new Error("MiniMax frame inputs cannot be combined with reference inputs");
  for (const { inputs, kind, limit } of references) {
    if (inputs.length > limit) throw new Error(`MiniMax allows at most ${limit} reference ${kind} inputs`);
  }
  if (referenceCount > 12) throw new Error("MiniMax allows at most 12 reference inputs in total");
  const content: Record<string, unknown>[] = [{ type: "text", text: options.prompt }];
  for (const [input, role] of [[options.firstFrame, "first_frame"], [options.lastFrame, "last_frame"]] as const) {
    if (input !== undefined) {
      const url = await resolveVideoMedia(input, "image", options.cwd ?? process.cwd(), options.signal);
      content.push({ type: "image_url", image_url: { url }, role });
    }
  }
  for (const { inputs, kind } of references) {
    for (const input of inputs) {
      const url = await resolveVideoMedia(input, kind, options.cwd ?? process.cwd(), options.signal);
      content.push({ type: `${kind}_url`, [`${kind}_url`]: { url }, role: `reference_${kind}` });
    }
  }
  const ratio = hasFrames ? "adaptive" : options.ratio ?? config.extraBody.ratio ?? (referenceCount ? "adaptive" : "16:9");
  const allowedRatios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", ...(hasFrames || referenceCount ? ["adaptive"] : [])];
  if (!allowedRatios.includes(String(ratio))) throw new Error(`MiniMax H3 ratio must be ${allowedRatios.join(", ")}`);
  const body = { ...config.extraBody, model, content, resolution, duration, ratio };
  if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024 * 1024) throw new Error("MiniMax request exceeds 64 MB; use public image URLs instead of inline images");
  return body;
}

export async function generateWithMiniMax(options: GenerateVideoOptions): Promise<GeneratedVideo[]> {
  const { config } = options;
  if (!config.apiKey || config.apiKey === "codex") throw new Error("MiniMax requires its own API key: set PI_TEXT2VIDEO_API_KEY (or MINIMAX_API_KEY), or apiKey in the text2video config");
  if (options.signal?.aborted) throw new Error("cancelled");
  const budget = AbortSignal.timeout(config.pollTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  let id: string | undefined;
  try {
    const body = await requestBody({ ...options, signal });
    const submitted = await apiRequest(videosEndpoint(config), config, signal, body);
    id = submitted.task_id;
    if (typeof id !== "string" || !id) throw new Error("MiniMax response has no task_id");
    for (;;) {
      const { task } = await apiRequest(videoStatusEndpoint(config, id), config, signal);
      if (typeof task?.status !== "string" || !task.status) throw new Error(`MiniMax task ${id} response has no status`);
      if (["failed", "cancelled", "expired"].includes(task.status)) {
        throw new Error(`MiniMax task ${id} ${task.status}: ${task.error?.message ?? task.error?.code ?? "no details"}`);
      }
      if (task.status === "succeeded") {
        const url = task.content?.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error(`MiniMax task ${id} succeeded without a download URL`);
        // The task supplies a signed CDN URL; never forward API keys/custom headers.
        const response = await readResponse(url, config, signal, undefined, false);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`MiniMax video download failed ${response.status}`);
        }
        const data = response.data;
        if (!data.length) throw new Error("MiniMax video download returned zero bytes");
        const mimeType = videoMimeType(data) ?? "video/mp4";
        return [{ data, mimeType, ext: extFor(mimeType) }];
      }
      options.onProgress?.(`MiniMax video job ${id}: ${task.status}`);
      await delay(config.pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    if (options.signal?.aborted) throw new Error("cancelled");
    if (budget.aborted) throw new Error(`MiniMax video job ${id ?? "submission"} timed out after ${config.pollTimeoutMs}ms — raise pollTimeoutMs in the text2video config`);
    throw error;
  }
}
