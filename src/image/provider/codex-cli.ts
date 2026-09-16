// Reuse an existing Codex login instead of an API key.
//
// Codex's bundled imagegen skill has two modes, and the preferred one is a
// server-side built-in `image_gen` tool that runs inside a Codex turn and is
// billed to the ChatGPT plan — its SKILL.md says in so many words that it "does
// not require OPENAI_API_KEY". That tool is not reachable over HTTP: it only
// exists inside a Codex session. So this backend runs `codex exec`, lets Codex
// generate, and then collects the files Codex wrote under
// $CODEX_HOME/generated_images. Nothing here touches auth.json or its tokens.
//
// The trade-off against the openai provider: an agent turn takes a minute or
// two instead of seconds, and the model picks the exact resolution.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { imageFromFile } from "../media.ts";
import type { GenerateOptions, GeneratedImage } from "../types.ts";
import * as os from "node:os";
import * as path from "node:path";

import { codexGeneratedImagesDir, codexHome, type Text2ImageConfig } from "../../config.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
// mtime granularity plus the gap between our clock read and the first write.
const MTIME_SLACK_MS = 3_000;

export interface CodexRunOptions {
  config: Text2ImageConfig;
  prompt: string;
  n: number;
  size?: string;
  signal?: AbortSignal;
}

function buildPrompt(prompt: string, n: number, size?: string): string {
  return [
    `Generate ${n} image(s) with the built-in image_gen tool from the imagegen skill.`,
    "",
    `Image prompt: ${prompt}`,
    size ? `Target size: ${size}.` : "",
    "",
    "Rules:",
    "- Use the built-in image_gen tool only. Never the CLI fallback, and never ask for an OPENAI_API_KEY.",
    "- Do not resize, convert, move, copy or delete any file, and do not run shell commands.",
    "- Reply with the absolute path of each generated image, one per line, and nothing else.",
  ]
    .filter(Boolean)
    .join("\n");
}

function runCodex(options: CodexRunOptions, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { config } = options;
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-C",
    cwd,
    ...(config.codexModel ? ["-m", config.codexModel] : []),
    buildPrompt(options.prompt, options.n, options.size),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(config.codexCommand, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`\`${config.codexCommand} exec\` timed out after ${Math.round(config.timeoutMs / 1000)}s. Raise timeoutMs, or use the openai provider for a faster path.`));
    }, config.timeoutMs);

    const onAbort = () => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("cancelled"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `\`${config.codexCommand}\` not found on PATH — install the Codex CLI or set codexCommand` : err.message;
      reject(new Error(reason));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!settled) resolve({ stdout, stderr, code });
    });
  });
}

/** Files Codex wrote during this run, oldest first. */
function collectNewImages(dir: string, since: number): string[] {
  const found: { file: string; mtimeMs: number }[] = [];
  const walk = (current: string) => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!IMAGE_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= since) found.push({ file: full, mtimeMs: stat.mtimeMs });
      } catch {
        // raced with a write, skip
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs).map((entry) => entry.file);
}

/** Fallback for a Codex version that saves elsewhere: trust the paths it reported. */
function pathsFromOutput(stdout: string): string[] {
  const matches = stdout.match(/\/\S+\.(?:png|jpe?g|webp|gif)\b/gi) ?? [];
  return [...new Set(matches)].filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** Absolute paths of the images Codex just produced. Reading them is the caller's job. */
export async function generateImagesWithCodex(options: CodexRunOptions): Promise<string[]> {
  const generatedDir = codexGeneratedImagesDir();
  const startedAt = Date.now() - MTIME_SLACK_MS;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-text2image-codex-"));

  try {
    const result = await runCodex(options, workdir);
    const files = collectNewImages(generatedDir, startedAt);
    const found = files.length > 0 ? files : pathsFromOutput(result.stdout);

    if (found.length === 0) {
      const detail = tail(result.stderr) || tail(result.stdout) || "(no output)";
      throw new Error(
        `\`${options.config.codexCommand} exec\` exited with code ${result.code} and produced no image under ${generatedDir}.\n` +
          `Check that the Codex login works (\`codex login status\`, CODEX_HOME=${codexHome()}) and that its imagegen skill is enabled.\n${detail}`,
      );
    }
    // More images than asked for means older leftovers slipped past the mtime
    // filter; the newest ones are this run's.
    return found.slice(-options.n);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

/** Adapt this provider to the common in-memory image result. */
export async function generateWithCodexCli(options: GenerateOptions): Promise<GeneratedImage[]> {
  const { config } = options;
  const n = Math.min(Math.max(options.n ?? 1, 1), 10);
  const size = options.size?.trim() || config.size;
  const results = await generateImagesWithCodex({ config, prompt: options.prompt, n, size, signal: options.signal });
  return results.map(imageFromFile);
}
