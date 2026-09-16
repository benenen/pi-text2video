// Proxy resolution.
//
// The Codex CLI reaches chatgpt.com through the proxy in $CODEX_HOME/.env, and
// that file is the only place it is configured — pi's own process never sees
// those variables. Node's fetch ignores HTTPS_PROXY anyway (undici needs an
// explicit dispatcher), so both the proxy lookup and the tunnelling are ours to
// do. Precedence: explicit config → $CODEX_HOME/.env → process environment.

import * as fs from "node:fs";
import * as path from "node:path";

import { codexHome } from "./config.ts";

export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  /** Where the values came from, for /image config. */
  source: "config" | "codex-env" | "environment" | "none";
}

/** Minimal dotenv: KEY=VALUE, optional quotes, # comments, `export ` prefix. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function codexEnvPath(): string {
  return path.join(codexHome(), ".env");
}

export function readCodexEnv(): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(codexEnvPath(), "utf-8"));
  } catch {
    return {};
  }
}

function pickEnv(source: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = source[name] ?? source[name.toLowerCase()];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

export function resolveProxySettings(explicit?: { httpProxy?: string; httpsProxy?: string; noProxy?: string }): ProxySettings {
  if (explicit?.httpProxy || explicit?.httpsProxy) return { ...explicit, source: "config" };

  const codexEnv = readCodexEnv();
  const fromCodex = {
    httpProxy: pickEnv(codexEnv, "HTTP_PROXY"),
    httpsProxy: pickEnv(codexEnv, "HTTPS_PROXY"),
    noProxy: pickEnv(codexEnv, "NO_PROXY"),
  };
  if (fromCodex.httpProxy || fromCodex.httpsProxy) return { ...fromCodex, source: "codex-env" };

  const fromEnv = {
    httpProxy: pickEnv(process.env, "HTTP_PROXY"),
    httpsProxy: pickEnv(process.env, "HTTPS_PROXY"),
    noProxy: pickEnv(process.env, "NO_PROXY"),
  };
  if (fromEnv.httpProxy || fromEnv.httpsProxy) return { ...fromEnv, source: "environment" };

  return { source: "none" };
}

/** NO_PROXY semantics: comma-separated hosts, leading dot or bare suffix match, `*` for everything. */
export function bypassesProxy(targetHost: string, noProxy?: string): boolean {
  if (!noProxy) return false;
  const host = targetHost.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase().replace(/:\d+$/, "");
    if (!entry) continue;
    if (entry === "*") return true;
    const bare = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** The proxy URL to use for a target, or undefined for a direct connection. */
export function proxyForUrl(target: URL, settings: ProxySettings): URL | undefined {
  if (bypassesProxy(target.hostname, settings.noProxy)) return undefined;
  const raw = target.protocol === "https:" ? settings.httpsProxy ?? settings.httpProxy : settings.httpProxy ?? settings.httpsProxy;
  if (!raw) return undefined;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
}

/** Host:port plus credential presence — never the credentials themselves. */
export function describeProxy(proxy: URL | undefined): string {
  if (!proxy) return "direct";
  return `${proxy.protocol}//${proxy.username ? "***@" : ""}${proxy.host}`;
}
