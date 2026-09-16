// The extension itself: feed it a fake ExtensionAPI / ExtensionContext and
// exercise the tool, the command and the renderers.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader, startFakeVideosApi } from "./pi-runtime.mjs";

const videoApi = await startFakeVideosApi();
process.env.PI_TEXT2VIDEO_BASE_URL = videoApi.baseUrl;
process.env.PI_TEXT2VIDEO_API_KEY = "sk-video-abcd1234";
process.env.PI_TEXT2VIDEO_POLL_INTERVAL_MS = "5";
delete process.env.PI_TEXT2VIDEO_EXTRA_BODY;

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t2v-ext-"));
const loader = await createLoader();
const factory = await loader.import("extensions/text2video.ts", { default: true });

const tools = [];
const commands = new Map();
const renderers = new Map();
const entries = [];
factory({
  registerTool: (tool) => tools.push(tool),
  registerCommand: (name, options) => commands.set(name, options),
  registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
  appendEntry: (type, data) => entries.push({ type, data }),
});

assert.deepEqual(tools.map((tool) => tool.name), ["generate_video"]);
assert.deepEqual([...commands.keys()], ["video"]);
assert.deepEqual([...renderers.keys()].sort(), ["text2video", "text2video-info"]);
console.log("✓ registers only the video tool, command and renderers");

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, italic: (text) => text };
const notices = [];
const statuses = [];
let confirmAnswer = true;
const makeCtx = (input) => ({
  cwd,
  hasUI: true,
  model: { input },
  ui: {
    notify: (message, level) => notices.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }),
    input: async () => "dialog prompt",
    confirm: async () => confirmAnswer,
  },
});

// ---- text-to-video ----
const videoTool = tools.find((tool) => tool.name === "generate_video");
const videoUpdates = [];
const videoResult = await videoTool.execute("call-v1", { prompt: "a paper boat", seconds: "8", size: "720x1280" }, undefined, (update) => videoUpdates.push(update), makeCtx(["text"]));
assert.equal(videoResult.details.files.length, 1);
assert.ok(videoResult.details.files[0].path.endsWith(".mp4"));
assert.ok(fs.existsSync(videoResult.details.files[0].path));
assert.equal(videoResult.details.provider, "openai");
assert.match(videoResult.details.endpoint, /^POST http:\/\/127\.0\.0\.1:\d+\/v1\/videos$/);
assert.equal(videoResult.details.requestedSize, "720x1280");
assert.equal(videoResult.details.requestedSeconds, "8");
assert.match(videoResult.content[0].text, /Provider: openai · model: sora-2/);
assert.match(videoResult.content[0].text, /requested: 720x1280, 8s/);
assert.equal(videoResult.content.filter((block) => block.type === "image").length, 0, "clips are never inlined");
assert.ok(videoUpdates.some((update) => /this takes minutes/.test(update.content[0].text)));
assert.ok(videoUpdates.some((update) => /video job/.test(update.content[0].text)), "poll progress reaches the user");
assert.equal(videoApi.requests.find((entry) => entry.method === "POST").body.seconds, "8");
console.log("✓ generate_video runs the job, saves the clip and reports progress");

assert.match(videoTool.renderCall({ prompt: "a paper boat", seconds: "8" }, theme, {}).render(80).join(""), /generate_video/);
// Long temporary paths wrap at terminal width; join the visible path fragments.
const renderedVideo = videoTool.renderResult(videoResult, { expanded: false, isPartial: false }, theme, { showImages: true }).render(80).map((line) => line.trim()).join("");
assert.ok(renderedVideo.includes("1 video(s)") && renderedVideo.includes(videoResult.details.files[0].path));
assert.ok(renderedVideo.includes("/v1/videos"), "the rendered result names the backend");
assert.match(videoTool.renderResult({ content: [], details: undefined }, { expanded: false, isPartial: true }, theme, {}).render(80).join(""), /generating video/);
console.log("✓ generate_video renderCall / renderResult");

await assert.rejects(() => videoTool.execute("call-v2", { prompt: "x", model: "unauthorized" }, undefined, undefined, makeCtx(["text"])), /401/);
console.log("✓ generate_video throws on failure");

const videoCommand = commands.get("video");
await videoCommand.handler("a paper boat --seconds 8 --size 720x1280", makeCtx(["text"]));
const videoEntry = entries.at(-1);
assert.equal(videoEntry.type, "text2video");
assert.equal(videoEntry.data.prompt, "a paper boat");
assert.equal(videoEntry.data.files.length, 1);
assert.match(videoEntry.data.endpoint, /\/v1\/videos$/);
assert.ok(renderers.get("text2video")(videoEntry, { expanded: false }, theme).render(80).join("\n").includes("🎬 video"), "the /video card renders");
assert.deepEqual(statuses.at(-1), { key: "text2video", text: undefined }, "status must be cleared");
console.log("✓ /video generates and appends a TUI entry");

await videoCommand.handler("", makeCtx(["text"]));
assert.equal(entries.at(-1).data.prompt, "dialog prompt");
console.log("✓ /video without arguments opens the input dialog");

await videoCommand.handler("config", makeCtx(["text"]));
assert.equal(entries.at(-1).type, "text2video-info");
assert.ok(renderers.get("text2video-info")(entries.at(-1), { expanded: false }, theme).render(80).length > 0);
const videoInfo = entries.at(-1).data.lines.join("\n");
assert.ok(videoInfo.includes("sk-v…1234") && !videoInfo.includes("sk-video-abcd1234"));
assert.ok(videoInfo.includes("text2video.json"), "the config card names the video config file");
console.log("✓ /video config output is redacted and points at its own file");

const videoConfigPath = path.join(cwd, ".pi", "text2video.json");
await videoCommand.handler("config set seconds 6 --project", makeCtx(["text"]));
assert.equal(JSON.parse(fs.readFileSync(videoConfigPath, "utf-8")).seconds, "6");
assert.ok(entries.at(-1).data.lines.join("\n").includes("seconds"), "the change is reported");
confirmAnswer = false;
await videoCommand.handler("config set model veo-3 --project", makeCtx(["text"]));
assert.equal(JSON.parse(fs.readFileSync(videoConfigPath, "utf-8")).model, undefined, "a declined change must not be written");
confirmAnswer = true;
await videoCommand.handler("config set nonsense 1", makeCtx(["text"]));
assert.match(notices.at(-1).message, /unknown video config key/);
console.log("✓ /video config set writes, asks first, and rejects unknown keys");

await videoCommand.handler("x --model unauthorized", makeCtx(["text"]));
assert.equal(notices.at(-1).level, "error");
assert.match(notices.at(-1).message, /Text-to-video failed[\s\S]*401/);
console.log("✓ /video reports failure and clears status");

videoApi.close();
fs.rmSync(cwd, { recursive: true, force: true });
console.log("video-extension.test.mjs passed\n");
