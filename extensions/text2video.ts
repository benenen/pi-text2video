// Text-to-video for pi: clips are saved to disk and never inlined into model context.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { describeChanges } from "../src/codex-import.ts";
import {
  coerceVideoConfigValue, describeVideoBackend, describeVideoConfig, loadVideoConfig,
  projectVideoConfigPath, resolveOutputDir, userVideoConfigPath, VIDEO_CONFIG_FIELDS, writeConfigPatch,
} from "../src/config.ts";
import { formatBytes } from "../src/files.ts";
import { describeVideoProxy } from "../src/proxy-env.ts";
import { generateVideos, saveVideos, type SavedVideo, type GenerateVideoOptions } from "../src/videos.ts";
import { errorMessage, registerInfoRenderer, type InfoEntryData } from "./lib/ui.ts";

interface VideoFile {
  path: string;
  mimeType: string;
  bytes: number;
}

interface GenerateVideoDetails {
  prompt: string;
  /** Provider, interface and model recorded for each generated clip. */
  provider: string;
  endpoint: string;
  model: string;
  requestedSize?: string;
  requestedSeconds?: string;
  files: VideoFile[];
  elapsedMs: number;
}

interface VideoEntryData {
  prompt: string;
  provider: string;
  endpoint: string;
  model: string;
  files: VideoFile[];
  elapsedMs: number;
}

function toVideoFile(saved: SavedVideo): VideoFile {
  return { path: saved.path, mimeType: saved.mimeType, bytes: saved.bytes };
}

/** Clips are never previewed, so the path and the size are the whole summary. */
function videoFileSummary(file: VideoFile): string {
  return `${file.path} (${file.mimeType}, ${formatBytes(file.bytes)})`;
}

function videoLines(details: { provider: string; model: string; endpoint: string; files: VideoFile[]; elapsedMs: number; requestedSize?: string; requestedSeconds?: string }): string[] {
  const requested = [details.requestedSize, details.requestedSeconds ? `${details.requestedSeconds}s` : undefined].filter(Boolean).join(", ");
  return [
    `Generated ${details.files.length} video(s) in ${(details.elapsedMs / 1000).toFixed(0)}s.`,
    `Provider: ${details.provider} · model: ${details.model}${requested ? ` · requested: ${requested}` : ""}`,
    `Interface: ${details.endpoint}`,
    ...details.files.map((file) => `- ${videoFileSummary(file)}`),
    "(Clips are saved to disk only — pi has no video content block to inline.)",
  ];
}

type VideoCommandArgs = Pick<GenerateVideoOptions, "prompt" | "seconds" | "size" | "model" | "firstFrame" | "lastFrame" | "referenceImages" | "referenceVideos" | "referenceAudios" | "ratio">;

/** The config card plus the one thing describeVideoConfig cannot infer: the proxy in effect. */
function videoConfigLines(config: ReturnType<typeof loadVideoConfig>, cwd: string): string[] {
  return [...describeVideoConfig(config, cwd), "", `proxy      ${describeVideoProxy(config)}`];
}

function parseVideoArgs(input: string): VideoCommandArgs {
  const tokens = input.match(/--[\w-]+=(?:"[^"]*"|'[^']*'|\S+)|"[^"]*"|'[^']*'|\S+/g) ?? [];
  const unquote = (value: string | undefined) => value?.replace(/^["']|["']$/g, "");
  const words: string[] = [];
  let seconds: string | undefined;
  let size: string | undefined;
  let model: string | undefined;
  let firstFrame: string | undefined;
  let lastFrame: string | undefined;
  let ratio: string | undefined;
  const referenceImages: string[] = [];
  const referenceVideos: string[] = [];
  const referenceAudios: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const inline = token.match(/^--(seconds|duration|size|model|first-frame|last-frame|reference-image|reference-video|reference-audio|ratio)=(.*)$/);
    const isFlag = inline !== null || /^--?(seconds|duration|d|size|model|m|first-frame|last-frame|reference-image|reference-video|reference-audio|ratio)$/.test(token);
    if (isFlag) {
      const name = inline ? inline[1] : token.replace(/^--?/, "");
      const value = inline ? unquote(inline[2]) : unquote(tokens[++i]);
      if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      if (name === "seconds" || name === "duration" || name === "d") seconds = value;
      else if (name === "size") size = value;
      else if (name === "model" || name === "m") model = value;
      else if (name === "first-frame") firstFrame = value;
      else if (name === "last-frame") lastFrame = value;
      else if (name === "reference-image") referenceImages.push(value);
      else if (name === "reference-video") referenceVideos.push(value);
      else if (name === "reference-audio") referenceAudios.push(value);
      else if (name === "ratio") ratio = value;
      continue;
    }
    words.push(unquote(token) ?? token);
  }

  return { prompt: words.join(" ").trim(), seconds, size, model, firstFrame, lastFrame, referenceImages, referenceVideos, referenceAudios, ratio };
}

export default function (pi: ExtensionAPI) {
  // ---- the video tool ----
  pi.registerTool({
    name: "generate_video",
    label: "Generate Video",
    description:
      "Generate a short video clip from a text prompt and optional MiniMax H3 frame or reference media through the configured video provider, " +
      "save it to disk and return its absolute path. This is an asynchronous job: it runs for minutes and " +
      "costs money per clip, so call it once with a well-written prompt rather than iterating blindly.",
    promptSnippet: "Generate video from text or MiniMax H3 frame images and save it to disk",
    promptGuidelines: [
      "Use generate_video when the user asks for a video, an animation or a moving shot to be created.",
      "Do not use generate_video for still images (use generate_image) or for motion that is really code — write CSS, SVG or a script for those.",
      "generate_video takes minutes and bills per clip: write one detailed prompt — subject, camera movement, lighting, style — instead of generating variants.",
      "For MiniMax H3 image-to-video, pass firstFrame and/or lastFrame as local image paths, public URLs or image data URLs. Describe motion and desired dialogue, ambience or music in the prompt; H3 supports native audio without an audio flag.",
      "For MiniMax H3 reference generation, use referenceImages/referenceVideos/referenceAudios arrays. Preserve input order for references such as video 1 or audio 1. Reference mode cannot be combined with firstFrame or lastFrame. Set ratio to adaptive to follow the references.",
      "After generate_video returns, tell the user where the file landed; the path in the result is absolute.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "What to film, in English unless the user asked otherwise. Describe subject, action, camera movement, lighting and style — video models follow detailed prompts much better than short ones.",
      }),
      firstFrame: Type.Optional(Type.String({ description: "MiniMax H3 starting image: local path (relative to cwd), public HTTP(S) URL or base64 image data URL." })),
      lastFrame: Type.Optional(Type.String({ description: "MiniMax H3 ending image: local path, public HTTP(S) URL or base64 image data URL. Can be used alone or with firstFrame." })),
      referenceImages: Type.Optional(Type.Array(Type.String(), { maxItems: 9, description: "MiniMax reference images, ordered for image 1, image 2, etc. Local paths, public URLs or image data URLs. Cannot be combined with firstFrame/lastFrame." })),
      referenceVideos: Type.Optional(Type.Array(Type.String(), { maxItems: 3, description: "MiniMax reference videos in order. Local MP4/MOV paths, public URLs or video data URLs." })),
      referenceAudios: Type.Optional(Type.Array(Type.String(), { maxItems: 3, description: "MiniMax reference audio in order, e.g. audio 1 for voice/timbre. Local MP3/WAV paths, public URLs or audio data URLs." })),
      ratio: Type.Optional(Type.String({ description: "MiniMax aspect ratio: 21:9, 16:9, 4:3, 1:1, 3:4, 9:16; reference mode also accepts adaptive. Frame mode always follows the image." })),
      seconds: Type.Optional(Type.String({ description: 'Clip length in seconds, e.g. "4" or "8". Defaults to the configured seconds.' })),
      size: Type.Optional(Type.String({ description: "Video size, OpenAI: 1280x720 or 720x1280; MiniMax H3: 768P or 2K. Defaults to the configured size." })),
      model: Type.Optional(Type.String({ description: "Override the configured video model. Only set this when the user named a model." })),
      filename: Type.Optional(Type.String({ description: "Slug used in the saved file name. Defaults to a slug of the prompt." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadVideoConfig(ctx.cwd);
      const backend = describeVideoBackend(config, params.model);
      const size = params.size?.trim() || config.size;
      const seconds = params.seconds?.trim() || config.seconds;
      const requested = [size ? `at ${size}` : undefined, seconds ? `for ${seconds}s` : undefined].filter(Boolean).join(" ");

      onUpdate?.({ details: undefined, content: [{ type: "text", text: `Generating a video with ${backend.label} (${backend.model})${requested ? ` ${requested}` : ""}… this takes minutes.` }] });

      const started = Date.now();
      const videos = await generateVideos({
        config,
        prompt: params.prompt,
        firstFrame: params.firstFrame,
        lastFrame: params.lastFrame,
        referenceImages: params.referenceImages,
        referenceVideos: params.referenceVideos,
        referenceAudios: params.referenceAudios,
        ratio: params.ratio,
        cwd: ctx.cwd,
        size,
        seconds,
        model: params.model,
        signal,
        onProgress: (message) => onUpdate?.({ details: undefined, content: [{ type: "text", text: `Generating video… ${message}` }] }),
      });
      const files = saveVideos(videos, {
        outputDir: resolveOutputDir(ctx.cwd, config.outputDir),
        prompt: params.prompt,
        filename: params.filename,
      });
      const elapsedMs = Date.now() - started;
      const details = {
        prompt: params.prompt,
        provider: backend.label,
        endpoint: backend.endpoint,
        model: backend.model,
        requestedSize: size,
        requestedSeconds: seconds,
        files: files.map(toVideoFile),
        elapsedMs,
      };
      return { content: [{ type: "text", text: videoLines(details).join("\n") }], details };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("generate_video "));
      text += theme.fg("muted", `"${(args.prompt ?? "").slice(0, 80)}"`);
      const extras = [args.model, args.size, args.seconds ? `${args.seconds}s` : undefined, args.firstFrame ? "first frame" : undefined, args.lastFrame ? "last frame" : undefined, args.referenceImages?.length ? `${args.referenceImages.length} ref image(s)` : undefined, args.referenceVideos?.length ? `${args.referenceVideos.length} ref video(s)` : undefined, args.referenceAudios?.length ? `${args.referenceAudios.length} ref audio(s)` : undefined, args.ratio].filter(Boolean);
      if (extras.length > 0) text += theme.fg("dim", ` ${extras.join(" ")}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      const details = result.details as GenerateVideoDetails | undefined;
      if (isPartial || !details) return new Text(theme.fg("warning", "generating video…"), 0, 0);
      const summary = `✓ ${details.files.length} video(s) · ${details.provider ?? "?"} · ${details.model} · ${(details.elapsedMs / 1000).toFixed(0)}s`;
      const provenance = details.endpoint ? `  ${details.endpoint}` : "";
      const paths = details.files.map((file) => `  ${videoFileSummary(file)}`).join("\n");
      return new Text(`${theme.fg("success", summary)}\n${theme.fg("dim", [provenance, paths].filter(Boolean).join("\n"))}`, 0, 0);
    },
  });

  registerInfoRenderer(pi, "text2video-info");

  // ---- result card for /video (TUI only, never in context) ----
  pi.registerEntryRenderer<VideoEntryData>("text2video", (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${theme.fg("customMessageLabel", "🎬 video")} ${theme.fg("customMessageText", data.prompt)}`, 0, 0));
    box.addChild(new Text(theme.fg("dim", videoLines(data).slice(0, -1).join("\n")), 0, 0));
    return box;
  });

  // ---- text-to-video: /video ----
  pi.registerCommand("video", {
    description:
      "Text-to-video: /video <prompt> [--first-frame path-or-url] [--last-frame path-or-url] [--reference-image path-or-url] [--reference-video path-or-url] [--reference-audio path-or-url] [--ratio adaptive] [--seconds 4] [--size 1280x720] [--model xxx]; /video config shows the video config, /video config set <key> <value> [--project] changes it",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "config", label: "config — show the resolved video configuration" },
        { value: "config set ", label: "config set <key> <value> [--project] — write a setting" },
        { value: "--first-frame ", label: "--first-frame <path-or-url> — MiniMax H3 starting image" },
        { value: "--last-frame ", label: "--last-frame <path-or-url> — MiniMax H3 ending image" },
        { value: "--reference-image ", label: "--reference-image <path-or-url> — repeat for multiple images" },
        { value: "--reference-video ", label: "--reference-video <path-or-url> — repeat for multiple videos" },
        { value: "--reference-audio ", label: "--reference-audio <path-or-url> — repeat for multiple audio clips" },
        { value: "--ratio ", label: "--ratio <16:9|adaptive|...> — MiniMax aspect ratio" },
        { value: "--seconds ", label: "--seconds <n>" },
        { value: "--size ", label: "--size <width>x<height>" },
        { value: "--model ", label: "--model <model>" },
      ].filter((item) => item.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim();

      if (raw === "config" || raw === "--config") {
        pi.appendEntry<InfoEntryData>("text2video-info", { title: "🎬 text2video config", lines: videoConfigLines(loadVideoConfig(ctx.cwd), ctx.cwd) });
        return;
      }

      // `/video config set <key> <value> [--project|--user]`
      const setRequest = raw.match(/^config\s+set\b(.*)$/is);
      if (setRequest) {
        const tokens = (setRequest[1]?.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ""));
        const scope = tokens.includes("--project") ? "project" : "user";
        const [key, ...valueParts] = tokens.filter((token) => token !== "--project" && token !== "--user");
        if (!key) {
          pi.appendEntry<InfoEntryData>("text2video-info", {
            title: "🎬 text2video config set",
            lines: ["Usage: /video config set <key> <value> [--project]", "", ...VIDEO_CONFIG_FIELDS.map((field) => `${field.key.padEnd(16)} ${field.type.padEnd(8)} ${field.description}`)],
          });
          return;
        }
        try {
          const patch = { [key]: coerceVideoConfigValue(key, valueParts.join(" ")) };
          const target = scope === "project" ? projectVideoConfigPath(ctx.cwd) : userVideoConfigPath();
          if (ctx.hasUI) {
            const approved = await ctx.ui.confirm("Change the video config?", `write ${target}\n${key}: ${JSON.stringify(patch[key])}`);
            if (!approved) {
              ctx.ui.notify("No change written.", "info");
              return;
            }
          }
          const applied = writeConfigPatch(target, patch);
          const changes = describeChanges(applied.before, applied.after);
          pi.appendEntry<InfoEntryData>("text2video-info", {
            title: "🎬 text2video config changed",
            lines: [`wrote ${applied.path}`, ...(changes.length > 0 ? changes.map((change) => `  ${change}`) : ["  (no change)"]), "", ...videoConfigLines(loadVideoConfig(ctx.cwd), ctx.cwd)],
          });
        } catch (err) {
          ctx.ui.notify(`Cannot change the video config: ${errorMessage(err)}`, "error");
        }
        return;
      }

      let parsed: ReturnType<typeof parseVideoArgs>;
      try {
        parsed = parseVideoArgs(raw);
      } catch (err) {
        ctx.ui.notify(`Invalid video arguments: ${errorMessage(err)}`, "error");
        return;
      }
      let prompt = parsed.prompt;
      if (!prompt) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /video <prompt> [--first-frame path-or-url] [--last-frame path-or-url] [--reference-image path-or-url] [--reference-video path-or-url] [--reference-audio path-or-url] [--ratio adaptive] [--seconds 4] [--size 1280x720] [--model xxx]", "warning");
          return;
        }
        prompt = (await ctx.ui.input("Video prompt", "a paper boat drifting down a rain-soaked street, cinematic"))?.trim() ?? "";
        if (!prompt) return;
      }

      const config = loadVideoConfig(ctx.cwd);
      const backend = describeVideoBackend(config, parsed.model);
      const size = parsed.size?.trim() || config.size;
      const seconds = parsed.seconds?.trim() || config.seconds;
      ctx.ui.setStatus("text2video", `🎬 generating with ${backend.label} (${backend.model})… this takes minutes`);
      const started = Date.now();
      try {
        const videos = await generateVideos({
          config,
          prompt,
          firstFrame: parsed.firstFrame,
          lastFrame: parsed.lastFrame,
          referenceImages: parsed.referenceImages,
          referenceVideos: parsed.referenceVideos,
          referenceAudios: parsed.referenceAudios,
          ratio: parsed.ratio,
          cwd: ctx.cwd,
          size,
          seconds,
          model: parsed.model,
          onProgress: (message) => ctx.ui.setStatus("text2video", `🎬 ${message}`),
        });
        const files = saveVideos(videos, { outputDir: resolveOutputDir(ctx.cwd, config.outputDir), prompt });
        pi.appendEntry<VideoEntryData>("text2video", {
          prompt,
          provider: backend.label,
          endpoint: backend.endpoint,
          model: backend.model,
          files: files.map(toVideoFile),
          elapsedMs: Date.now() - started,
        });
        ctx.ui.notify(`Generated ${files.length} video(s) → ${files.map((file) => file.path).join(", ")}`, "info");
      } catch (err) {
        ctx.ui.notify(`Text-to-video failed: ${errorMessage(err)}`, "error");
      } finally {
        ctx.ui.setStatus("text2video", undefined);
      }
    },
  });
}
