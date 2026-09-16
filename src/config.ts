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

export type ApiKeySource = "config" | "openai-env" | "codex" | "none";

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

export function loadConfig(cwd: string): Text2ImageConfig {
  const user = readJson(userConfigPath());
  const project = readJson(projectConfigPath(cwd));
  const env = process.env;

  // An explicit empty string is meaningful input ("do not send this field"), so
  // it stays distinguishable from "not configured".
  const pickRaw = (key: string, envKey: string): string | undefined => {
    const fromEnv = env[envKey];
    if (typeof fromEnv === "string") return fromEnv.trim();
    for (const source of [project, user]) {
      const value = source[key];
      if (typeof value === "string") return value.trim();
    }
    return undefined;
  };
  const pick = (key: string, envKey: string): string | undefined => pickRaw(key, envKey) || undefined;

  const pickNumber = (key: string, envKey: string): number | undefined => {
    const raw = pick(key, envKey) ?? (typeof project[key] === "number" ? String(project[key]) : undefined) ?? (typeof user[key] === "number" ? String(user[key]) : undefined);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

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
    codexTokenUrl: pick("codexTokenUrl", "PI_TEXT2IMAGE_CODEX_TOKEN_URL") ?? DEFAULTS.codexTokenUrl,
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
): { apiKey: string; apiKeySource: ApiKeySource; codexHint?: string } {
  const wantsCodex = configured?.toLowerCase() === "codex";
  if (configured && !wantsCodex) return { apiKey: configured, apiKeySource: "config" };

  const fromEnv = env.OPENAI_API_KEY?.trim();
  if (!wantsCodex && fromEnv) return { apiKey: fromEnv, apiKeySource: "openai-env" };

  const disabled = /^(0|false|no)$/i.test(env.PI_TEXT2IMAGE_USE_CODEX_AUTH ?? "") || files.some((file) => file.useCodexAuth === false);
  if (!wantsCodex && disabled) return { apiKey: "", apiKeySource: "none" };

  const codex = readCodexCredential();
  if (codex.apiKey) return { apiKey: codex.apiKey, apiKeySource: "codex" };

  let codexHint: string | undefined;
  if (!codex.exists) {
    if (wantsCodex) codexHint = `apiKey is set to "codex" but ${codex.path} does not exist — run \`codex login\` first.`;
  } else if (codex.authMode === "chatgpt") {
    codexHint =
      `${codex.path} is a ChatGPT account login: its token is scoped to the Codex backend and the public images API rejects it ` +
      "(403, missing scopes). Store an API key instead — `printenv OPENAI_API_KEY | codex login --with-api-key` — or set apiKey in the text2image config.";
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

function apiKeyOrigin(config: Text2ImageConfig): string {
  switch (config.apiKeySource) {
    case "config":
      return " (from text2image config)";
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
    `apiKey     ${redactKey(config.apiKey)}${apiKeyOrigin(config)}`,
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
