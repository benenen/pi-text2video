// `/image config import codex`: turn an existing Codex login into a working
// config, instead of making the user hand-write one.
//
// What gets written depends on how codex is logged in:
//   - API-key login  → provider "openai" with apiKey "codex", which reads the
//     key from auth.json at call time. The key itself is never copied.
//   - ChatGPT login  → provider "codex", plus the first image-capable model the
//     account actually accepts, found by probing.

import { probeCodexModel } from "./image/provider/codex-api.ts";
import { codexAuthPath, projectConfigPath, readCodexCredential, userConfigPath, writeConfigPatch, type Text2ImageConfig } from "./config.ts";

/** Re-exported here because the import flow has always exposed it from this module. */
export { describeChanges } from "./config.ts";
import { describeProxy, proxyForUrl, resolveProxySettings } from "./proxy-env.ts";

/** Tried in order; the configured model goes first. */
export const MODEL_CANDIDATES = ["gpt-6-astra", "gpt-5.6", "gpt-6", "gpt-5.1-codex"];

export interface ImportPlan {
  target: string;
  patch: Record<string, unknown>;
  notes: string[];
  warnings: string[];
}

export interface ImportOptions {
  config: Text2ImageConfig;
  cwd: string;
  scope?: "user" | "project";
  /** Probing costs one tiny request per candidate; skip it to accept the default model. */
  probe?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export async function planCodexImport(options: ImportOptions): Promise<ImportPlan> {
  const { config, cwd } = options;
  const target = options.scope === "project" ? projectConfigPath(cwd) : userConfigPath();
  const credential = readCodexCredential();
  const notes: string[] = [];
  const warnings: string[] = [];

  if (!credential.exists) {
    throw new Error(`no codex login found at ${codexAuthPath()} — run \`codex login\` first (or set CODEX_HOME)`);
  }

  if (credential.apiKey) {
    notes.push(`${codexAuthPath()}: API-key login (auth_mode: ${credential.authMode ?? "apikey"})`);
    notes.push("text2image will read that key from auth.json at call time; nothing is copied into the config");
    return { target, patch: { provider: "openai", apiKey: "codex" }, notes, warnings };
  }

  notes.push(`${codexAuthPath()}: ChatGPT account login (auth_mode: ${credential.authMode ?? "chatgpt"})`);
  notes.push("that token cannot call the public images API, so the Codex backend's built-in image tool is used instead");

  const proxySettings = resolveProxySettings();
  const proxy = proxyForUrl(new URL(config.codexBaseUrl), proxySettings);
  notes.push(`proxy: ${describeProxy(proxy)}${proxy ? ` (from ${proxySettings.source})` : ""}`);

  const patch: Record<string, unknown> = { provider: "codex", codexMode: "api" };

  if (options.probe === false) {
    notes.push(`model: ${config.codexApiModel} (not probed)`);
    patch.codexApiModel = config.codexApiModel;
    return { target, patch, notes, warnings };
  }

  const candidates = [config.codexApiModel, ...MODEL_CANDIDATES].filter((model, index, all) => model && all.indexOf(model) === index);
  for (const model of candidates) {
    options.onProgress?.(`probing ${model}…`);
    let result: Awaited<ReturnType<typeof probeCodexModel>>;
    try {
      result = await probeCodexModel(config, model, options.signal);
    } catch (err) {
      warnings.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    if (result.supported) {
      notes.push(`model: ${model} (accepted by this account)`);
      patch.codexApiModel = model;
      return { target, patch, notes, warnings };
    }
    if (result.unsupportedModel) {
      notes.push(`model: ${model} rejected (${result.status}: ${result.detail})`);
      continue;
    }
    // Some other 4xx/5xx: the model may well be fine, so keep it rather than
    // ruling out the whole API path on an unrelated error.
    warnings.push(`probe was inconclusive for ${model} (${result.status}${result.detail ? `: ${result.detail}` : ""}); keeping it and leaving codexMode "api"`);
    patch.codexApiModel = model;
    return { target, patch, notes, warnings };
  }

  warnings.push("no candidate model was accepted for the direct API path; falling back to codexMode \"cli\", which drives `codex exec` instead");
  patch.codexMode = "cli";
  return { target, patch, notes, warnings };
}

/** Merges the patch into whatever is already there and writes it back. */
export function applyCodexImport(plan: ImportPlan): { path: string; before: Record<string, unknown>; after: Record<string, unknown> } {
  return writeConfigPatch(plan.target, plan.patch);
}
