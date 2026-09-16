// Configuration resolution. Precedence, highest first:
// environment variables → project config → user config → defaults.
//
// Only one protocol is supported here: the OpenAI-compatible images API
// (POST {baseUrl}/images/generations). OpenAI itself, SiliconFlow, an internal
// gateway, one-api / self-hosted vLLM all speak it. Vendor-specific knobs are
// passed through via extraBody instead of being modelled one by one.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Text2ImageConfig {
  /**
   * "openai": talk to an OpenAI-compatible images API with a key.
   * "codex": drive `codex exec` so an existing Codex login generates the image
   * with its server-side built-in image_gen tool — no API key involved.
   */
  provider: Provider;
  baseUrl: string;
  /** May be empty: gateways that need no key get no Authorization header. */
  apiKey: string;
  apiKeySource: ApiKeySource;
  /** Why an existing codex login could not supply a key. Attached to 401/403 errors. */
  codexHint?: string;
  model: string;
  /** undefined means "do not send a size field" — some services reject it. */
  size?: string;
  /** Relative paths resolve against cwd, see resolveOutputDir(). */
  outputDir: string;
  timeoutMs: number;
  /** Not sent by default: gpt-image-1 returns 400 when it sees this field. */
  responseFormat?: string;
  headers: Record<string, string>;
  /** provider "codex" only. */
  codexMode: CodexMode;
  codexCommand: string;
  codexModel?: string;
  /** codexMode "api" only. */
  codexBaseUrl: string;
  codexApiModel: string;
  codexOriginator: string;
  /** Unset means "derive it from the id_token in auth.json", see codex-api.ts. */
  codexClientId?: string;
  codexTokenUrl: string;
  codexRefresh: boolean;
  /** Merged into the request body verbatim — negative_prompt, guidance_scale and friends. */
  extraBody: Record<string, unknown>;
}

export type Provider = "openai" | "codex";

/**
 * "api" (default): read the tokens from auth.json and call the Codex backend
 * directly. Faster — about 40s against 70s — and it costs no agent turn, but it
 * speaks a private protocol and identifies itself as the Codex CLI.
 * "cli": spawn `codex exec` and let the Codex CLI own the credential and the
 * turn. Slower, and the fallback whenever the private protocol changes.
 */
export type CodexMode = "cli" | "api";

export type ApiKeySource = "config" | "openai-env" | "minimax-env" | "codex" | "none";

/**
 * Video generation is a second, independent backend. It gets its own config file
 * (`text2video.json`) and its own env prefix (`PI_TEXT2VIDEO_*`), because a video
 * service is usually a different endpoint with different credentials from the
 * images API — and its jobs are asynchronous, which images are not.
 */
export type VideoProvider = "openai" | "minimax";

export interface Text2VideoConfig {
  provider: VideoProvider;
  baseUrl: string;
  /** May be empty: gateways that need no key get no Authorization header. */
  apiKey: string;
  apiKeySource: ApiKeySource;
  /** Why an existing codex login could not supply a key. Attached to 401/403 errors. */
  codexHint?: string;
  model: string;
  /** undefined means "do not send a size field". */
  size?: string;
  /** Clip length; MiniMax maps this to its required integer `duration`. */
  seconds?: string;
  /** Relative paths resolve against cwd, see resolveOutputDir(). */
  outputDir: string;
  /** Timeout of a single HTTP request — submit, status poll or download. */
  timeoutMs: number;
  /** How long to wait for one asynchronous job; video takes minutes, not seconds. */
  pollTimeoutMs: number;
  pollIntervalMs: number;
  /** Not sent by default: an unknown response_format is rejected by most services. */
  responseFormat?: string;
  headers: Record<string, string>;
  /** Merged into the submit body verbatim — aspect_ratio, negative_prompt and friends. */
  extraBody: Record<string, unknown>;
}

export interface CodexCredential {
  path: string;
  exists: boolean;
  /** "chatgpt" for an OAuth login, "apikey" when a key was stored. */
  authMode?: string;
  /** Only set when codex holds a usable API key. */
  apiKey?: string;
}

/** A function, not a constant: tests point HOME elsewhere. */
export function userConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "text2image.json");
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "text2image.json");
}

export function userVideoConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "text2video.json");
}

export function projectVideoConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "text2video.json");
}

/** Honours CODEX_HOME the same way the codex CLI does. */
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

export function codexAuthPath(): string {
  return path.join(codexHome(), "auth.json");
}

/** Where the built-in image_gen tool leaves its output. */
export function codexGeneratedImagesDir(): string {
  return path.join(codexHome(), "generated_images");
}

/**
 * Reuse an existing codex login. Only the API-key login mode is usable here:
 * `codex login --with-api-key` stores the key as OPENAI_API_KEY in auth.json,
 * which is an ordinary key the images API accepts. A ChatGPT OAuth login stores
 * tokens scoped to the Codex backend instead — api.openai.com rejects those with
 * "insufficient permissions / missing scopes", so they are reported, not used.
 */
export function readCodexCredential(): CodexCredential {
  const file = codexAuthPath();
  const exists = fs.existsSync(file);
  const raw = exists ? readJson(file) : {};
  const key = typeof raw.OPENAI_API_KEY === "string" ? raw.OPENAI_API_KEY.trim() : "";
  const authMode = typeof raw.auth_mode === "string" ? raw.auth_mode : key ? "apikey" : undefined;
  return { path: file, exists, authMode, apiKey: key || undefined };
}

const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-image-1",
  size: "1024x1024",
  outputDir: ".pi/images",
  // Image generation is an order of magnitude slower than chat: 30-90s for a
  // cloud-hosted 1024x1024 is routine.
  timeoutMs: 180_000,
  codexTimeoutMs: 600_000,
  codexCommand: "codex",
  codexApiTimeoutMs: 300_000,
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  codexApiModel: "gpt-6-astra",
  codexOriginator: "codex_cli_rs",
  codexTokenUrl: "https://auth.openai.com/oauth/token",
} as const;

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseJsonEnv(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Env beats every config file, and files are consulted in the order given
 * (project before user). An explicit empty string is meaningful input ("do not
 * send this field"), so it stays distinguishable from "not configured".
 */
function createPickers(env: NodeJS.ProcessEnv, files: Record<string, unknown>[]) {
  const pickRaw = (key: string, envKey: string): string | undefined => {
    const fromEnv = env[envKey];
    if (typeof fromEnv === "string") return fromEnv.trim();
    for (const source of files) {
      const value = source[key];
      if (typeof value === "string") return value.trim();
    }
    return undefined;
  };
  return {
    pickRaw,
    pick: (key: string, envKey: string): string | undefined => pickRaw(key, envKey) || undefined,
    pickNumber: (key: string, envKey: string): number | undefined => {
      const fromFiles = files.map((source) => (typeof source[key] === "number" ? String(source[key]) : undefined)).find((value) => value !== undefined);
      const value = Number(pickRaw(key, envKey) || fromFiles);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    },
  };
}

export function loadConfig(cwd: string): Text2ImageConfig {
  const user = readJson(userConfigPath());
  const project = readJson(projectConfigPath(cwd));
  const env = process.env;
  const { pickRaw, pick, pickNumber } = createPickers(env, [project, user]);

  const provider: Provider = (pick("provider", "PI_TEXT2IMAGE_PROVIDER") ?? "openai").toLowerCase() === "codex" ? "codex" : "openai";
  const codexMode: CodexMode = (pick("codexMode", "PI_TEXT2IMAGE_CODEX_MODE") ?? "api").toLowerCase() === "cli" ? "cli" : "api";
  const sizeRaw = pickRaw("size", "PI_TEXT2IMAGE_SIZE");
  const baseUrl = pick("baseUrl", "PI_TEXT2IMAGE_BASE_URL") ?? env.OPENAI_BASE_URL?.trim() ?? DEFAULTS.baseUrl;
  // The codex provider carries no key at all: the Codex session owns the auth.
  const { apiKey, apiKeySource, codexHint } =
    provider === "codex" ? { apiKey: "", apiKeySource: "none" as const, codexHint: undefined } : resolveApiKey(pick("apiKey", "PI_TEXT2IMAGE_API_KEY"), env, [project, user]);

  return {
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    apiKeySource,
    codexHint,
    model: pick("model", "PI_TEXT2IMAGE_MODEL") ?? DEFAULTS.model,
    size: sizeRaw === undefined ? DEFAULTS.size : sizeRaw || undefined,
    outputDir: pick("outputDir", "PI_TEXT2IMAGE_OUTPUT_DIR") ?? DEFAULTS.outputDir,
    // A codex turn is a whole agent run, not one HTTP call: minutes, not seconds.
    timeoutMs:
      pickNumber("timeoutMs", "PI_TEXT2IMAGE_TIMEOUT_MS") ??
      (provider === "codex" ? (codexMode === "api" ? DEFAULTS.codexApiTimeoutMs : DEFAULTS.codexTimeoutMs) : DEFAULTS.timeoutMs),
    responseFormat: pick("responseFormat", "PI_TEXT2IMAGE_RESPONSE_FORMAT"),
    headers: {
      ...(asRecord(user.headers) ?? {}),
      ...(asRecord(project.headers) ?? {}),
      ...(parseJsonEnv(env.PI_TEXT2IMAGE_HEADERS) ?? {}),
    } as Record<string, string>,
    codexMode,
    codexCommand: pick("codexCommand", "PI_TEXT2IMAGE_CODEX_COMMAND") ?? DEFAULTS.codexCommand,
    codexModel: pick("codexModel", "PI_TEXT2IMAGE_CODEX_MODEL"),
    codexBaseUrl: (pick("codexBaseUrl", "PI_TEXT2IMAGE_CODEX_BASE_URL") ?? DEFAULTS.codexBaseUrl).replace(/\/+$/, ""),
    codexApiModel: pick("codexApiModel", "PI_TEXT2IMAGE_CODEX_API_MODEL") ?? DEFAULTS.codexApiModel,
    codexOriginator: pick("codexOriginator", "PI_TEXT2IMAGE_CODEX_ORIGINATOR") ?? DEFAULTS.codexOriginator,
    codexClientId: pick("codexClientId", "PI_TEXT2IMAGE_CODEX_CLIENT_ID"),
    // CODEX_REFRESH_TOKEN_URL_OVERRIDE is codex's own knob; honouring it keeps
    // both tools pointed at the same auth service.
    codexTokenUrl: pick("codexTokenUrl", "PI_TEXT2IMAGE_CODEX_TOKEN_URL") ?? env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() ?? DEFAULTS.codexTokenUrl,
    codexRefresh: !/^(0|false|no)$/i.test(pick("codexRefresh", "PI_TEXT2IMAGE_CODEX_REFRESH") ?? ""),
    extraBody: {
      ...(asRecord(user.extraBody) ?? {}),
      ...(asRecord(project.extraBody) ?? {}),
      ...(parseJsonEnv(env.PI_TEXT2IMAGE_EXTRA_BODY) ?? {}),
    },
  };
}

/**
 * apiKey precedence: this extension's own config/env, then OPENAI_API_KEY, then
 * an existing codex login. Setting apiKey to the literal "codex" skips the first
 * two and demands the codex credential, which makes the failure explicit.
 */
function resolveApiKey(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
  files: Record<string, unknown>[],
  context: { useCodexAuthEnvKey?: string; apiName?: string; configName?: string } = {},
): { apiKey: string; apiKeySource: ApiKeySource; codexHint?: string } {
  const useCodexAuthEnvKey = context.useCodexAuthEnvKey ?? "PI_TEXT2IMAGE_USE_CODEX_AUTH";
  const apiName = context.apiName ?? "images API";
  const configName = context.configName ?? "text2image config";
  const wantsCodex = configured?.toLowerCase() === "codex";
  if (configured && !wantsCodex) return { apiKey: configured, apiKeySource: "config" };

  const fromEnv = env.OPENAI_API_KEY?.trim();
  if (!wantsCodex && fromEnv) return { apiKey: fromEnv, apiKeySource: "openai-env" };

  const disabled = /^(0|false|no)$/i.test(env[useCodexAuthEnvKey] ?? "") || files.some((file) => file.useCodexAuth === false);
  if (!wantsCodex && disabled) return { apiKey: "", apiKeySource: "none" };

  const codex = readCodexCredential();
  if (codex.apiKey) return { apiKey: codex.apiKey, apiKeySource: "codex" };

  let codexHint: string | undefined;
  if (!codex.exists) {
    if (wantsCodex) codexHint = `apiKey is set to "codex" but ${codex.path} does not exist — run \`codex login\` first.`;
  } else if (codex.authMode === "chatgpt") {
    codexHint =
      `${codex.path} is a ChatGPT account login: its token is scoped to the Codex backend and the public ${apiName} rejects it ` +
      `(403, missing scopes). Store an API key instead — \`printenv OPENAI_API_KEY | codex login --with-api-key\` — or set apiKey in the ${configName}.`;
  } else {
    codexHint = `${codex.path} holds no OPENAI_API_KEY.`;
  }
  return { apiKey: "", apiKeySource: "none", codexHint };
}

/** A baseUrl that already points at a concrete endpoint is used as-is. */
export function imagesEndpoint(config: Text2ImageConfig): string {
  return /\/images\/(generations|edits)$/.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl}/images/generations`;
}

export function resolveOutputDir(cwd: string, outputDir: string): string {
  const expanded = outputDir.startsWith("~") ? path.join(os.homedir(), outputDir.slice(1)) : outputDir;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

export function redactKey(apiKey: string): string {
  if (!apiKey) return "(not set)";
  return apiKey.length <= 8 ? "****" : `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

export interface BackendDescription {
  /** Short provider id shown in the TUI and stored in the session. */
  label: string;
  /** The interface actually called: a URL, or the command line for the cli mode. */
  endpoint: string;
  model: string;
}

/**
 * Who generated an image and through what. Recorded on every result so a picture
 * found later can be traced back to the provider, endpoint and model that made it.
 */
export function describeBackend(config: Text2ImageConfig, modelOverride?: string): BackendDescription {
  if (config.provider === "codex") {
    return config.codexMode === "api"
      ? { label: "codex/api", endpoint: `POST ${config.codexBaseUrl}/responses (tool: image_generation)`, model: config.codexApiModel }
      : { label: "codex/cli", endpoint: `${config.codexCommand} exec (tool: image_gen)`, model: config.codexModel ?? "codex default" };
  }
  return { label: "openai", endpoint: `POST ${imagesEndpoint(config)}`, model: modelOverride?.trim() || config.model };
}

function apiKeyOrigin(config: { apiKeySource: ApiKeySource }, where: string): string {
  switch (config.apiKeySource) {
    case "config":
      return ` (from ${where} config)`;
    case "minimax-env":
      return " (from MINIMAX_API_KEY)";
    case "openai-env":
      return " (from OPENAI_API_KEY)";
    case "codex":
      return ` (from ${codexAuthPath()})`;
    default:
      return "";
  }
}

/** Lines shown by /image config. The key is always redacted. */
export function describeConfig(config: Text2ImageConfig, cwd: string): string[] {
  const common = [
    `outputDir  ${resolveOutputDir(cwd, config.outputDir)}`,
    `timeout    ${Math.round(config.timeoutMs / 1000)}s`,
  ];
  if (config.provider === "codex") {
    const credential = readCodexCredential();
    const how =
      config.codexMode === "api"
        ? [
            "provider   codex/api (Codex backend called directly, auth from auth.json)",
            `endpoint   ${config.codexBaseUrl}/responses`,
            `model      ${config.codexApiModel} (originator: ${config.codexOriginator}, refresh: ${config.codexRefresh ? "on" : "off"})`,
          ]
        : [
            "provider   codex/cli (built-in image_gen through `codex exec`, no tokens read)",
            `command    ${config.codexCommand} exec${config.codexModel ? ` -m ${config.codexModel}` : ""}`,
          ];
    return [
      ...how,
      `codex home ${codexHome()}${credential.exists ? ` (auth_mode: ${credential.authMode ?? "unknown"})` : " — not logged in, run `codex login`"}`,
      ...(config.codexMode === "api" ? [] : [`images in  ${codexGeneratedImagesDir()}`]),
      ...common,
      "",
      `user config     ${userConfigPath()}${fs.existsSync(userConfigPath()) ? "" : " (missing)"}`,
      `project config  ${projectConfigPath(cwd)}${fs.existsSync(projectConfigPath(cwd)) ? "" : " (missing)"}`,
    ];
  }
  const lines = [
    "provider   openai-compatible images API",
    `endpoint   ${imagesEndpoint(config)}`,
    `model      ${config.model}`,
    `size       ${config.size ?? "(not sent)"}`,
    `apiKey     ${redactKey(config.apiKey)}${apiKeyOrigin(config, "text2image")}`,
    ...common,
  ];
  if (config.codexHint) lines.push(`           ${config.codexHint}`);
  if (config.responseFormat) lines.push(`response_format ${config.responseFormat}`);
  const headerKeys = Object.keys(config.headers);
  if (headerKeys.length > 0) lines.push(`headers    ${headerKeys.join(", ")}`);
  const bodyKeys = Object.keys(config.extraBody);
  if (bodyKeys.length > 0) lines.push(`extraBody  ${bodyKeys.join(", ")}`);
  lines.push(
    "",
    `user config     ${userConfigPath()}${fs.existsSync(userConfigPath()) ? "" : " (missing)"}`,
    `project config  ${projectConfigPath(cwd)}${fs.existsSync(projectConfigPath(cwd)) ? "" : " (missing)"}`,
  );
  return lines;
}

// ----------------------------------------------------------------- video ---

const VIDEO_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "sora-2",
  size: "1280x720",
  seconds: "4",
  outputDir: ".pi/videos",
  // Submitting and polling are ordinary requests; the job itself is the slow part.
  timeoutMs: 180_000,
  // A video job runs for minutes — Sora 2 is routinely 1-5, and a busy queue is
  // longer. This is the budget for the whole job, not for one request.
  pollTimeoutMs: 900_000,
  pollIntervalMs: 5_000,
} as const;

function videoProvider(value: string): VideoProvider {
  const provider = value.trim().toLowerCase();
  if (provider !== "openai" && provider !== "minimax") throw new Error(`unknown video provider "${value}" — use openai or minimax`);
  return provider;
}

function minimaxBaseUrl(config: Text2VideoConfig): string {
  return config.baseUrl.replace(/\/+$/, "").replace(/\/v[12](?:\/video_generation)?$/, "");
}

export function loadVideoConfig(cwd: string): Text2VideoConfig {
  const user = readJson(userVideoConfigPath());
  const project = readJson(projectVideoConfigPath(cwd));
  const env = process.env;
  const { pickRaw, pick, pickNumber } = createPickers(env, [project, user]);

  const provider = videoProvider(pick("provider", "PI_TEXT2VIDEO_PROVIDER") ?? "openai");
  const minimax = provider === "minimax";
  const sizeRaw = pickRaw("size", "PI_TEXT2VIDEO_SIZE");
  const secondsRaw = pickRaw("seconds", "PI_TEXT2VIDEO_SECONDS");
  const baseUrl = pick("baseUrl", "PI_TEXT2VIDEO_BASE_URL") ?? (minimax ? "https://api.minimax.cn" : env.OPENAI_BASE_URL?.trim() ?? VIDEO_DEFAULTS.baseUrl);
  const configuredKey = pick("apiKey", "PI_TEXT2VIDEO_API_KEY");
  const { apiKey, apiKeySource, codexHint } = minimax
    ? { apiKey: configuredKey ?? env.MINIMAX_API_KEY?.trim() ?? "", apiKeySource: (configuredKey ? "config" : env.MINIMAX_API_KEY?.trim() ? "minimax-env" : "none") as ApiKeySource, codexHint: undefined }
    : resolveApiKey(configuredKey, env, [project, user], {
        useCodexAuthEnvKey: "PI_TEXT2VIDEO_USE_CODEX_AUTH",
        apiName: "videos API",
        configName: "text2video config",
      });

  return {
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    apiKeySource,
    codexHint,
    model: pick("model", "PI_TEXT2VIDEO_MODEL") ?? (minimax ? "MiniMax-H3" : VIDEO_DEFAULTS.model),
    size: sizeRaw === undefined ? (minimax ? "768P" : VIDEO_DEFAULTS.size) : sizeRaw || undefined,
    seconds: secondsRaw === undefined ? (minimax ? "6" : VIDEO_DEFAULTS.seconds) : secondsRaw || undefined,
    outputDir: pick("outputDir", "PI_TEXT2VIDEO_OUTPUT_DIR") ?? VIDEO_DEFAULTS.outputDir,
    timeoutMs: pickNumber("timeoutMs", "PI_TEXT2VIDEO_TIMEOUT_MS") ?? VIDEO_DEFAULTS.timeoutMs,
    pollTimeoutMs: pickNumber("pollTimeoutMs", "PI_TEXT2VIDEO_POLL_TIMEOUT_MS") ?? VIDEO_DEFAULTS.pollTimeoutMs,
    pollIntervalMs: pickNumber("pollIntervalMs", "PI_TEXT2VIDEO_POLL_INTERVAL_MS") ?? VIDEO_DEFAULTS.pollIntervalMs,
    responseFormat: pick("responseFormat", "PI_TEXT2VIDEO_RESPONSE_FORMAT"),
    headers: {
      ...(asRecord(user.headers) ?? {}),
      ...(asRecord(project.headers) ?? {}),
      ...(parseJsonEnv(env.PI_TEXT2VIDEO_HEADERS) ?? {}),
    } as Record<string, string>,
    extraBody: {
      ...(asRecord(user.extraBody) ?? {}),
      ...(asRecord(project.extraBody) ?? {}),
      ...(parseJsonEnv(env.PI_TEXT2VIDEO_EXTRA_BODY) ?? {}),
    },
  };
}

/** A baseUrl that already points at a concrete endpoint is used as-is. */
export function videosEndpoint(config: Text2VideoConfig): string {
  if (config.provider === "minimax") return `${minimaxBaseUrl(config)}/v2/video_generation`;
  return /\/videos(\/generations)?$/.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl}/videos`;
}

/** Where a submitted job reports progress. */
export function videoStatusEndpoint(config: Text2VideoConfig, id: string): string {
  if (config.provider === "minimax") return `${minimaxBaseUrl(config)}/v2/query/video_generation/${encodeURIComponent(id)}`;
  return `${videosEndpoint(config).replace(/\/generations$/, "")}/${encodeURIComponent(id)}`;
}

/** OpenAI's videos API keeps the finished bytes apart from the job description. */
export function videoContentEndpoint(config: Text2VideoConfig, id: string): string {
  return `${videoStatusEndpoint(config, id)}/content`;
}

/** Provenance for a generated clip, same contract as describeBackend(). */
export function describeVideoBackend(config: Text2VideoConfig, modelOverride?: string): BackendDescription {
  return { label: config.provider ?? "openai", endpoint: `POST ${videosEndpoint(config)}`, model: modelOverride?.trim() || config.model };
}

/** Lines shown by /video config. The key is always redacted. */
export function describeVideoConfig(config: Text2VideoConfig, cwd: string): string[] {
  const lines = [
    config.provider === "minimax" ? "provider   minimax (H3 video generation V2)" : "provider   openai-compatible videos API (submit a job, poll it, download)",
    `endpoint   ${videosEndpoint(config)}`,
    `model      ${config.model}`,
    `size       ${config.size ?? "(not sent)"}`,
    `seconds    ${config.seconds ?? "(not sent)"}`,
    `apiKey     ${redactKey(config.apiKey)}${apiKeyOrigin(config, "text2video")}`,
    `outputDir  ${resolveOutputDir(cwd, config.outputDir)}`,
    `timeout    ${Math.round(config.timeoutMs / 1000)}s per request; whole job ${Math.round(config.pollTimeoutMs / 1000)}s, polled every ${config.pollIntervalMs}ms`,
  ];
  if (config.codexHint) lines.push(`           ${config.codexHint}`);
  if (config.responseFormat) lines.push(`response_format ${config.responseFormat}`);
  const headerKeys = Object.keys(config.headers);
  if (headerKeys.length > 0) lines.push(`headers    ${headerKeys.join(", ")}`);
  const bodyKeys = Object.keys(config.extraBody);
  if (bodyKeys.length > 0) lines.push(`extraBody  ${bodyKeys.join(", ")}`);
  lines.push(
    "",
    `user config     ${userVideoConfigPath()}${fs.existsSync(userVideoConfigPath()) ? "" : " (missing)"}`,
    `project config  ${projectVideoConfigPath(cwd)}${fs.existsSync(projectVideoConfigPath(cwd)) ? "" : " (missing)"}`,
  );
  return lines;
}

export interface VideoConfigField {
  key: string;
  type: "string" | "number" | "boolean" | "json";
  description: string;
}

/** What `/video config set` accepts. Discovery-only keys (apiKeySource…) are not settable. */
export const VIDEO_CONFIG_FIELDS: VideoConfigField[] = [
  { key: "provider", type: "string", description: "openai or minimax" },
  { key: "baseUrl", type: "string", description: "API base URL; the provider appends its generation endpoint" },
  { key: "apiKey", type: "string", description: 'empty sends no Authorization header; "codex" borrows a codex API-key login' },
  { key: "model", type: "string", description: "e.g. sora-2 or MiniMax-H3" },
  { key: "size", type: "string", description: "OpenAI: 1280x720; MiniMax H3: 768P or 2K" },
  { key: "seconds", type: "string", description: "clip length, e.g. 4 or 8; empty string stops sending the field" },
  { key: "outputDir", type: "string", description: "relative to the working directory, ~ supported" },
  { key: "timeoutMs", type: "number", description: "one HTTP request" },
  { key: "pollTimeoutMs", type: "number", description: "the whole asynchronous job" },
  { key: "pollIntervalMs", type: "number", description: "delay between status polls" },
  { key: "responseFormat", type: "string", description: "rarely needed" },
  { key: "headers", type: "json", description: "extra request headers" },
  { key: "extraBody", type: "json", description: "merged into the submit body" },
  { key: "useCodexAuth", type: "boolean", description: "borrow a codex API key when none is configured" },
];

export function videoConfigField(key: string): VideoConfigField | undefined {
  return VIDEO_CONFIG_FIELDS.find((field) => field.key === key);
}

/** `/video config set` input → the JSON value written to the config file. */
export function coerceVideoConfigValue(key: string, raw: string): unknown {
  const field = videoConfigField(key);
  if (!field) throw new Error(`unknown video config key "${key}" — known keys: ${VIDEO_CONFIG_FIELDS.map((entry) => entry.key).join(", ")}`);
  if (key === "provider") return videoProvider(raw);
  if (field.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
    return value;
  }
  if (field.type === "boolean") {
    if (!/^(true|false|1|0|yes|no)$/i.test(raw.trim())) throw new Error(`${key} must be true or false`);
    return /^(true|1|yes)$/i.test(raw.trim());
  }
  if (field.type === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${key} must be a JSON object`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${key} must be a JSON object`);
    return parsed;
  }
  return raw;
}

/** Merge-write a config file, creating it (and its directory) if needed. */
export function writeConfigPatch(target: string, patch: Record<string, unknown>): { path: string; before: Record<string, unknown>; after: Record<string, unknown> } {
  const before = readJson(target);
  const after = { ...before, ...patch };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(after, null, 2)}\n`);
  return { path: target, before, after };
}

/** One line per changed key, for a confirmation dialog and a result card. */
export function describeChanges(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => `${key}: ${before[key] === undefined ? "" : `${JSON.stringify(before[key])} → `}${JSON.stringify(after[key])}`);
}
