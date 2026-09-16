// codexMode "api": call the Codex backend directly with the tokens an existing
// `codex login` already stored.
//
// The imagegen skill's preferred path is the server-side built-in image tool, so
// the request here is an ordinary Responses call carrying a single
// `image_generation` tool; the backend answers with an `image_generation_call`
// output item whose `result` is the PNG in base64.
//
// Two things to know before touching this file:
//   - It is a private protocol. There is no compatibility promise, and it
//     identifies itself with the same `originator` the Codex CLI sends; that is
//     the reason codexMode defaults to "cli".
//   - Tokens are read from auth.json and sent to the Codex backend only. They
//     are never written anywhere, never logged, and a refreshed token stays in
//     memory for this pi session instead of being written back to auth.json.

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import { codexAuthPath, type Text2ImageConfig } from "./config.ts";
import { request, sseEvents } from "./http.ts";
import { describeProxy, proxyForUrl, resolveProxySettings } from "./proxy-env.ts";

export interface CodexImage {
  base64: string;
  revisedPrompt?: string;
  /** Item id when the backend gives one; used to drop duplicates. */
  id?: string;
}

export interface CodexApiOptions {
  config: Text2ImageConfig;
  prompt: string;
  n: number;
  size?: string;
  signal?: AbortSignal;
}

export interface CodexTokens {
  accessToken: string;
  accountId?: string;
  refreshToken?: string;
}

/** Refreshed access tokens, kept for this process only. Keyed by refresh token. */
const refreshedTokens = new Map<string, string>();

export function readCodexTokens(): CodexTokens {
  const file = codexAuthPath();
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    throw new Error(`cannot read ${file} — run \`codex login\` first, or set CODEX_HOME`);
  }
  const accessToken = typeof raw?.tokens?.access_token === "string" ? raw.tokens.access_token : "";
  if (!accessToken) {
    throw new Error(
      raw?.OPENAI_API_KEY
        ? `${file} holds an API key rather than ChatGPT tokens — use provider "openai" with that key instead.`
        : `${file} has no access token — run \`codex login\` first.`,
    );
  }
  return {
    accessToken,
    accountId: typeof raw?.tokens?.account_id === "string" ? raw.tokens.account_id : undefined,
    refreshToken: typeof raw?.tokens?.refresh_token === "string" ? raw.tokens.refresh_token : undefined,
  };
}

/** Reads `exp` out of the JWT payload. No signature check: this only decides when to refresh. */
function expiresWithin(accessToken: string, seconds: number): boolean {
  const payload = accessToken.split(".")[1];
  if (!payload) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
    return typeof decoded?.exp === "number" && decoded.exp * 1000 - Date.now() < seconds * 1000;
  } catch {
    return false;
  }
}

async function refreshAccessToken(config: Text2ImageConfig, tokens: CodexTokens, signal?: AbortSignal): Promise<string> {
  if (!tokens.refreshToken) throw new Error("the access token expired and auth.json has no refresh token — run `codex login` again");
  const url = new URL(config.codexTokenUrl);
  const proxy = proxyForUrl(url, resolveProxySettings());
  const response = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: config.codexClientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      scope: "openid profile email",
    }),
    signal,
    timeoutMs: 60_000,
    proxy,
  });
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`token refresh failed with ${response.status} ${response.statusText} — run \`codex login\` again.\n${body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(body) as { access_token?: string };
  if (!parsed.access_token) throw new Error("token refresh returned no access token — run `codex login` again");
  refreshedTokens.set(tokens.refreshToken, parsed.access_token);
  return parsed.access_token;
}

/** Headers the Codex backend expects. The token is the caller's to supply. */
function codexHeaders(config: Text2ImageConfig, tokens: CodexTokens, accessToken: string, accept: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    ...(tokens.accountId ? { "chatgpt-account-id": tokens.accountId } : {}),
    "content-type": "application/json",
    accept,
    originator: config.codexOriginator,
    session_id: randomUUID(),
    "openai-beta": "responses=experimental",
    "user-agent": config.codexOriginator,
  };
}

/**
 * Is this model usable with this account? A trivial text request settles it: an
 * unsupported model is rejected before any work happens, so the probe never
 * generates an image and the stream is dropped as soon as the status is known.
 *
 * Only a 400 that actually says the model is unsupported counts as a no. The
 * backend rejects other things with 400 too — `max_output_tokens` for one — and
 * reading those as "unsupported model" is how a working model gets ruled out.
 */
export async function probeCodexModel(config: Text2ImageConfig, model: string, signal?: AbortSignal): Promise<{ supported: boolean; unsupportedModel: boolean; status: number; detail?: string }> {
  const tokens = readCodexTokens();
  let accessToken = (tokens.refreshToken && refreshedTokens.get(tokens.refreshToken)) || tokens.accessToken;
  if (config.codexRefresh && expiresWithin(accessToken, 60)) accessToken = await refreshAccessToken(config, tokens, signal);

  const url = new URL(`${config.codexBaseUrl}/responses`);
  const response = await request(url, {
    method: "POST",
    headers: codexHeaders(config, tokens, accessToken, "text/event-stream"),
    body: JSON.stringify({
      model,
      instructions: "Reply with OK.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "OK" }] }],
      store: false,
      stream: true,
    }),
    signal,
    timeoutMs: 60_000,
    proxy: proxyForUrl(url, resolveProxySettings()),
  });

  if (response.status >= 200 && response.status < 300) {
    response.stream.destroy();
    return { supported: true, unsupportedModel: false, status: response.status };
  }
  const body = await response.text();
  const detail = (() => {
    try {
      const parsed = JSON.parse(body);
      return parsed?.detail ?? parsed?.error?.message ?? body.slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  })();
  return {
    supported: false,
    unsupportedModel: response.status === 400 && /model is not supported/i.test(String(detail)),
    status: response.status,
    detail: String(detail),
  };
}

function buildBody(config: Text2ImageConfig, prompt: string, size?: string): string {
  const tool: Record<string, unknown> = { type: "image_generation" };
  // "auto" and WIDTHxHEIGHT are both valid; anything else is left to the backend.
  if (size) tool.size = size;
  return JSON.stringify({
    model: config.codexApiModel,
    instructions: "You generate images. Call the image_generation tool exactly once with the user's prompt, then stop. Do not ask questions and do not explain.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [tool],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    stream: true,
  });
}

function imagesFromEvent(event: any): CodexImage[] {
  const items: any[] =
    event?.type === "response.output_item.done" && event.item
      ? [event.item]
      : event?.type === "response.completed" && Array.isArray(event?.response?.output)
        ? event.response.output
        : [];
  return items
    .filter((item) => item?.type === "image_generation_call" && typeof item?.result === "string" && item.result.length > 0)
    .map((item) => ({
      base64: item.result as string,
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      id: typeof item.id === "string" ? item.id : undefined,
    }));
}

async function requestOneImage(config: Text2ImageConfig, tokens: CodexTokens, accessToken: string, prompt: string, size: string | undefined, signal: AbortSignal | undefined): Promise<{ images: CodexImage[]; status: number; error?: string }> {
  const url = new URL(`${config.codexBaseUrl}/responses`);
  const proxy = proxyForUrl(url, resolveProxySettings());
  const response = await request(url, {
    method: "POST",
    headers: codexHeaders(config, tokens, accessToken, "text/event-stream"),
    body: buildBody(config, prompt, size),
    signal,
    timeoutMs: config.timeoutMs,
    proxy,
  });

  if (response.status < 200 || response.status >= 300) {
    const body = (await response.text()).slice(0, 400);
    const hint =
      response.status === 401
        ? " — the access token was rejected; run `codex login` again"
        : response.status === 403
          ? ` — the backend refused this request (proxy: ${describeProxy(proxy)}); the account may not be allowed to use this path`
          : response.status === 404
            ? ` — check codexBaseUrl (${config.codexBaseUrl})`
            : response.status === 400 && /model is not supported/i.test(body)
              ? ` — set codexApiModel to a model your account may use with Codex; "gpt-6-astra" works on a ChatGPT plan, the gpt-5.x names do not`
              : "";
    return { images: [], status: response.status, error: `Codex backend returned ${response.status} ${response.statusText}${hint}\n${body}` };
  }

  // The same image arrives twice: once as output_item.done and again inside
  // response.completed. Key on the item id, or on the payload when there is none.
  const images: CodexImage[] = [];
  const seen = new Set<string>();
  const remember = (image: CodexImage) => {
    const key = image.id ?? `${image.base64.length}:${image.base64.slice(0, 64)}`;
    if (seen.has(key)) return;
    seen.add(key);
    images.push(image);
  };

  for await (const data of sseEvents(response.stream)) {
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.type === "response.failed" || event?.type === "error") {
      const message = event?.response?.error?.message ?? event?.error?.message ?? event?.message ?? "unknown error";
      return { images, status: response.status, error: `Codex backend reported: ${message}` };
    }
    for (const image of imagesFromEvent(event)) remember(image);
    if (images.length > 0 && event?.type === "response.completed") break;
  }
  return { images, status: response.status };
}

export async function generateImagesViaCodexApi(options: CodexApiOptions): Promise<CodexImage[]> {
  const { config, prompt, size, signal } = options;
  const tokens = readCodexTokens();

  let accessToken = (tokens.refreshToken && refreshedTokens.get(tokens.refreshToken)) || tokens.accessToken;
  if (config.codexRefresh && expiresWithin(accessToken, 60)) {
    accessToken = await refreshAccessToken(config, tokens, signal);
  }

  const collected: CodexImage[] = [];
  for (let i = 0; i < options.n; i++) {
    let attempt = await requestOneImage(config, tokens, accessToken, prompt, size, signal);

    // One retry after a refresh: the token may have expired between the check and the call.
    if (attempt.status === 401 && config.codexRefresh && tokens.refreshToken) {
      accessToken = await refreshAccessToken(config, tokens, signal);
      attempt = await requestOneImage(config, tokens, accessToken, prompt, size, signal);
    }
    if (attempt.error) throw new Error(attempt.error);
    if (attempt.images.length === 0) {
      throw new Error(`the Codex backend returned no image. The model may have declined, or ${config.codexApiModel} may not offer the built-in image tool — try another codexApiModel, or codexMode "cli".`);
    }
    collected.push(...attempt.images);
    if (collected.length >= options.n) break;
  }
  return collected.slice(0, options.n);
}
