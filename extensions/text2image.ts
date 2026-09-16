// Text-to-image for pi, backed by any OpenAI-compatible images API.
//
// Two entry points with different jobs:
//   - the generate_image tool: the model decides when to draw ("throw in an icon
//     for this"), and the result joins the LLM context;
//   - the /image command: a human draws on purpose, and the result only reaches
//     the TUI (appendEntry stays out of context) — no context burned on a picture.
//
// Files are written to disk either way: inline previews need a terminal that
// speaks the kitty or iTerm2 image protocol, so the saved file is the only
// dependable artifact and its absolute path always appears in the text.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, getCapabilities, Image, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

import { applyCodexImport, describeChanges, planCodexImport } from "../src/codex-import.ts";
import { describeBackend, describeConfig, loadConfig, resolveOutputDir, type Text2ImageConfig } from "../src/config.ts";
import { formatBytes, generateImages, saveImages, type SavedImage } from "../src/images.ts";

// Budget for inlining into the LLM context. A 1024x1024 PNG is ~2MB once base64
// encoded, so a handful of them blows up the context: only the first few are
// inlined, oversized ones are skipped, and every path is always listed in text.
const MAX_INLINE_IMAGES = 2;
const MAX_INLINE_BYTES = 4 * 1024 * 1024;
const PREVIEW_WIDTH_CELLS = 60;

interface ImageFile {
  path: string;
  mimeType: string;
  bytes: number;
}

interface GenerateDetails {
  prompt: string;
  /** Provenance: which provider, which interface, which model. */
  provider: string;
  endpoint: string;
  model: string;
  size?: string;
  files: ImageFile[];
  /** Whether the images went into the tool result as image blocks — if they did, pi draws them and renderResult must not draw them again. */
  inlined: boolean;
  elapsedMs: number;
}

interface ImageEntryData {
  prompt: string;
  provider: string;
  endpoint: string;
  model: string;
  files: ImageFile[];
  elapsedMs: number;
}

interface InfoEntryData {
  title: string;
  lines: string[];
}

function toImageFile(saved: SavedImage): ImageFile {
  return { path: saved.path, mimeType: saved.mimeType, bytes: saved.bytes };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The kitty protocol only accepts PNG — pi's built-in renderer makes the same check. */
function canPreview(mimeType: string): boolean {
  const caps = getCapabilities();
  if (!caps.images) return false;
  return !(caps.images === "kitty" && mimeType !== "image/png");
}

function previewComponent(file: ImageFile, theme: Theme): Image | undefined {
  if (!canPreview(file.mimeType)) return undefined;
  try {
    const base64 = fs.readFileSync(file.path).toString("base64");
    return new Image(base64, file.mimeType, { fallbackColor: (text) => theme.fg("toolOutput", text) }, { maxWidthCells: PREVIEW_WIDTH_CELLS });
  } catch {
    // Moved or deleted: drop the preview, the path line is still useful.
    return undefined;
  }
}

function parseCommandArgs(input: string): { prompt: string; n?: number; size?: string; model?: string } {
  const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const unquote = (value: string | undefined) => value?.replace(/^["']|["']$/g, "");
  const words: string[] = [];
  let n: number | undefined;
  let size: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const inline = token.match(/^--(n|size|model)=(.*)$/);
    const name = inline ? inline[1] : token.replace(/^--?/, "");
    const isFlag = inline !== null || /^--?(n|s|size|m|model)$/.test(token);
    if (isFlag) {
      const value = inline ? unquote(inline[2]) : unquote(tokens[++i]);
      if (name === "n") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) n = parsed;
      } else if (name === "s" || name === "size") {
        size = value;
      } else if (name === "m" || name === "model") {
        model = value;
      }
      continue;
    }
    words.push(unquote(token) ?? token);
  }

  return { prompt: words.join(" ").trim(), n, size, model };
}

export default function (pi: ExtensionAPI) {
  // ---- the tool the model can call ----
  const parameters = Type.Object({
    prompt: Type.String({
      description:
        "What to draw, in English unless the user asked otherwise. Be specific about subject, style, composition and lighting — these models follow detailed prompts much better than short ones.",
    }),
    n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "How many images to generate. Defaults to 1." })),
    size: Type.Optional(Type.String({ description: "Image size, e.g. 1024x1024, 1536x1024, 1024x1536. Defaults to the configured size." })),
    model: Type.Optional(Type.String({ description: "Override the configured image model. Only set this when the user named a model." })),
    filename: Type.Optional(Type.String({ description: "Slug used in the saved file name. Defaults to a slug of the prompt." })),
  });

  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate image(s) from a text prompt through the configured OpenAI-compatible images API, " +
      "save them to disk and return their absolute paths. Generation takes tens of seconds and costs " +
      "money per image, so call it once with a well-written prompt rather than iterating blindly.",
    promptSnippet: "Generate images from a text prompt and save them to disk",
    promptGuidelines: [
      "Use generate_image when the user asks for a picture, illustration, icon, logo, concept art or mockup to be created rather than found or coded.",
      "Do not use generate_image for diagrams, charts or anything whose value is in being exact — write SVG, mermaid or code for those.",
      "After generate_image returns, tell the user where the files landed; the paths in the result are absolute.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const backend = describeBackend(config, params.model);
      const size = params.size?.trim() || config.size;
      const count = params.n ?? 1;

      onUpdate?.({
        content: [{ type: "text", text: `Generating ${count} image(s) with ${backend.label} (${backend.model})${size ? ` at ${size}` : ""}…` }],
      });

      const started = Date.now();
      const images = await generateImages({ config, prompt: params.prompt, n: count, size, model: params.model, signal });
      const files = saveImages(images, {
        outputDir: resolveOutputDir(ctx.cwd, config.outputDir),
        prompt: params.prompt,
        filename: params.filename,
      });
      const elapsedMs = Date.now() - started;

      // Only a model that can see images is worth spending base64 on; for the
      // rest it is pure token waste.
      const modelSeesImages = ctx.model?.input?.includes("image") ?? false;
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

      const lines = [
        `Generated ${files.length} image(s) in ${(elapsedMs / 1000).toFixed(1)}s.`,
        `Provider: ${backend.label} · model: ${backend.model}${size ? ` · size: ${size}` : ""}`,
        `Interface: ${backend.endpoint}`,
        ...files.map((file) => `- ${file.path} (${formatBytes(file.bytes)})`),
      ];
      const revised = files.find((file) => file.revisedPrompt)?.revisedPrompt;
      if (revised) lines.push(`Provider rewrote the prompt as: ${revised}`);
      if (!modelSeesImages) lines.push("(The current model has no image input, so the images are on disk only.)");
      content.push({ type: "text", text: lines.join("\n") });

      let inlined = false;
      if (modelSeesImages) {
        for (const [index, image] of images.entries()) {
          if (index >= MAX_INLINE_IMAGES || image.data.byteLength > MAX_INLINE_BYTES) break;
          content.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
          inlined = true;
        }
      }

      return {
        content,
        details: {
          prompt: params.prompt,
          provider: backend.label,
          endpoint: backend.endpoint,
          model: backend.model,
          size,
          files: files.map(toImageFile),
          inlined,
          elapsedMs,
        },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("generate_image "));
      text += theme.fg("muted", `"${(args.prompt ?? "").slice(0, 80)}"`);
      const extras = [args.model, args.size, args.n && args.n > 1 ? `×${args.n}` : undefined].filter(Boolean);
      if (extras.length > 0) text += theme.fg("dim", ` ${extras.join(" ")}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme, context) {
      const details = result.details as GenerateDetails | undefined;
      if (isPartial || !details) {
        return new Text(theme.fg("warning", "generating…"), 0, 0);
      }

      const container = new Container();
      const summary = `✓ ${details.files.length} image(s) · ${details.provider ?? "?"} · ${details.model} · ${(details.elapsedMs / 1000).toFixed(1)}s`;
      const provenance = details.endpoint ? `  ${details.endpoint}` : "";
      const paths = details.files.map((file) => `  ${file.path} (${formatBytes(file.bytes)})`).join("\n");
      container.addChild(new Text(`${theme.fg("success", summary)}\n${theme.fg("dim", [provenance, paths].filter(Boolean).join("\n"))}`, 0, 0));

      // Inlined images are drawn by pi itself; this only covers the case where
      // they never entered the context.
      if (!details.inlined && context.showImages) {
        for (const file of details.files.slice(0, MAX_INLINE_IMAGES)) {
          const preview = previewComponent(file, theme);
          if (preview) container.addChild(preview);
        }
      }
      return container;
    },
  });

  // ---- result card for /image (TUI only, never in context) ----
  pi.registerEntryRenderer<ImageEntryData>("text2image", (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;

    const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    const header = `${theme.fg("customMessageLabel", "🎨 image")} ${theme.fg("customMessageText", data.prompt)}`;
    const meta = `${data.provider ?? "?"} · ${data.model} · ${data.files.length} image(s) · ${(data.elapsedMs / 1000).toFixed(1)}s`;
    const provenance = data.endpoint ? `  ${data.endpoint}` : "";
    const paths = data.files.map((file) => `  ${file.path} (${formatBytes(file.bytes)})`).join("\n");
    box.addChild(new Text(`${header}\n${theme.fg("dim", meta)}\n${theme.fg("dim", [provenance, paths].filter(Boolean).join("\n"))}`, 0, 0));

    for (const file of data.files) {
      const preview = previewComponent(file, theme);
      if (preview) box.addChild(preview);
    }
    return box;
  });

  pi.registerEntryRenderer<InfoEntryData>("text2image-info", (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${theme.fg("customMessageLabel", data.title)}\n${theme.fg("dim", data.lines.join("\n"))}`, 0, 0));
    return box;
  });

  // ---- manual entry point ----
  pi.registerCommand("image", {
    description: "Text-to-image: /image <prompt> [--n 2] [--size 1024x1024] [--model xxx]; /image config shows the config, /image config import codex sets it up from a Codex login",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "config", label: "config — show the resolved configuration" },
        { value: "config import codex", label: "config import codex — configure from an existing Codex login" },
        { value: "--n ", label: "--n <count>" },
        { value: "--size ", label: "--size <width>x<height>" },
        { value: "--model ", label: "--model <model>" },
      ].filter((item) => item.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const raw = args.trim();

      // `/image config import codex [--project] [--no-probe]`, also `/image import codex`
      const importRequest = raw.match(/^(?:config\s+)?import(?:\s+codex)?\b(.*)$/i);
      if (importRequest) {
        const flags = importRequest[1] ?? "";
        ctx.ui.setStatus("text2image", "🎨 reading codex login…");
        try {
          const plan = await planCodexImport({
            config,
            cwd: ctx.cwd,
            scope: /--project\b/.test(flags) ? "project" : "user",
            probe: !/--no-probe\b/.test(flags),
            onProgress: (message) => ctx.ui.setStatus("text2image", `🎨 ${message}`),
          });
          const preview = Object.entries(plan.patch).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
          if (ctx.hasUI) {
            const approved = await ctx.ui.confirm(
              "Import codex login?",
              [...plan.notes, ...plan.warnings.map((warning) => `! ${warning}`), "", `write ${plan.target}`, ...preview].join("\n"),
            );
            if (!approved) {
              ctx.ui.notify("Import cancelled; nothing was written.", "info");
              return;
            }
          }
          const applied = applyCodexImport(plan);
          const changes = describeChanges(applied.before, applied.after);
          pi.appendEntry<InfoEntryData>("text2image-info", {
            title: "🎨 imported codex login",
            lines: [
              ...plan.notes,
              ...plan.warnings.map((warning) => `! ${warning}`),
              "",
              `wrote ${applied.path}`,
              ...(changes.length > 0 ? changes.map((change) => `  ${change}`) : ["  (already up to date)"]),
              "",
              ...describeConfig(loadConfig(ctx.cwd), ctx.cwd),
            ],
          });
        } catch (err) {
          ctx.ui.notify(`Import failed: ${errorMessage(err)}`, "error");
        } finally {
          ctx.ui.setStatus("text2image", undefined);
        }
        return;
      }

      if (raw === "config" || raw === "--config") {
        pi.appendEntry<InfoEntryData>("text2image-info", { title: "🎨 text2image config", lines: describeConfig(config, ctx.cwd) });
        return;
      }

      const parsed = parseCommandArgs(raw);
      let prompt = parsed.prompt;
      if (!prompt) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /image <prompt> [--n 2] [--size 1024x1024] [--model xxx]", "warning");
          return;
        }
        prompt = (await ctx.ui.input("Image prompt", "a red panda drinking tea, watercolour"))?.trim() ?? "";
        if (!prompt) return;
      }

      const backend = describeBackend(config, parsed.model);
      ctx.ui.setStatus("text2image", `🎨 generating with ${backend.label} (${backend.model})…`);
      const started = Date.now();
      try {
        const images = await generateImages({ config, prompt, n: parsed.n, size: parsed.size, model: parsed.model });
        const files = saveImages(images, { outputDir: resolveOutputDir(ctx.cwd, config.outputDir), prompt });
        pi.appendEntry<ImageEntryData>("text2image", {
          prompt,
          provider: backend.label,
          endpoint: backend.endpoint,
          model: backend.model,
          files: files.map(toImageFile),
          elapsedMs: Date.now() - started,
        });
        if (!getCapabilities().images) {
          ctx.ui.notify(`Generated ${files.length} image(s) → ${path.dirname(files[0].path)} (this terminal cannot show images inline)`, "info");
        }
      } catch (err) {
        ctx.ui.notify(`Text-to-image failed: ${errorMessage(err)}`, "error");
      } finally {
        ctx.ui.setStatus("text2image", undefined);
      }
    },
  });
}
