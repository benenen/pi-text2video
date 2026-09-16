// Video config resolution and the videos client: real requests against a local
// fake service that runs the whole submit → poll → download dance.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader, startFakeVideosApi } from "./pi-runtime.mjs";

const api = await startFakeVideosApi();
process.env.PI_TEXT2VIDEO_BASE_URL = api.baseUrl;
process.env.PI_TEXT2VIDEO_API_KEY = "video-key-5678";
process.env.PI_TEXT2VIDEO_POLL_INTERVAL_MS = "5";
process.env.PI_TEXT2VIDEO_EXTRA_BODY = JSON.stringify({ aspect_ratio: "16:9" });

const loader = await createLoader();
const {
  loadVideoConfig,
  videosEndpoint,
  videoStatusEndpoint,
  videoContentEndpoint,
  describeVideoConfig,
  coerceVideoConfigValue,
  writeConfigPatch,
  loadConfig,
} = await loader.import("src/config.ts");
const { generateVideos, saveVideos, videoMimeType } = await loader.import("src/videos.ts");

// Container sniffing, since services commonly label video bytes octet-stream
assert.equal(videoMimeType(api.mp4Buffer), "video/mp4");
assert.equal(videoMimeType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])), "video/webm");
assert.equal(videoMimeType(Buffer.from("not a video")), undefined);
console.log("✓ mp4 and webm recognised from their magic bytes");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t2v-"));
const config = loadVideoConfig(cwd);
assert.equal(videosEndpoint(config), `${api.baseUrl}/videos`);
assert.equal(videoStatusEndpoint(config, "abc"), `${api.baseUrl}/videos/abc`);
assert.equal(videoContentEndpoint(config, "abc"), `${api.baseUrl}/videos/abc/content`);
assert.equal(config.model, "sora-2");
assert.equal(config.size, "1280x720");
assert.equal(config.seconds, "4");
assert.equal(config.extraBody.aspect_ratio, "16:9");
assert.equal(config.pollIntervalMs, 5);
console.log("✓ video config resolution and endpoints");

// The async path: submit, poll twice, fetch the bytes from /content
const progress = [];
let videos = await generateVideos({ config, prompt: "a paper boat", onProgress: (message) => progress.push(message) });
assert.equal(videos.length, 1);
assert.equal(videos[0].mimeType, "video/mp4");
assert.equal(videos[0].ext, "mp4");
assert.deepEqual(videos[0].data, api.mp4Buffer);
assert.ok(progress.some((message) => /queued|in_progress/.test(message)), `progress was reported: ${JSON.stringify(progress)}`);

const submit = api.requests.find((entry) => entry.method === "POST");
assert.equal(submit.url, "/v1/videos");
assert.equal(submit.headers.authorization, "Bearer video-key-5678");
assert.equal(submit.body.model, "sora-2");
assert.equal(submit.body.prompt, "a paper boat");
assert.equal(submit.body.size, "1280x720");
assert.equal(submit.body.seconds, "4");
assert.equal(submit.body.aspect_ratio, "16:9");
assert.equal(submit.body.response_format, undefined, "response_format must stay unset by default");
console.log("✓ async job: submit, poll, download /content");

const saved = saveVideos(videos, { outputDir: path.join(cwd, "videos"), prompt: "a paper boat" });
assert.ok(fs.existsSync(saved[0].path));
assert.ok(saved[0].path.endsWith(".mp4"));
assert.equal(saved[0].bytes, api.mp4Buffer.byteLength);
console.log("✓ saved to", path.basename(saved[0].path));

// Synchronous replies: some gateways hand back a url or base64 right away
assert.equal((await generateVideos({ config, prompt: "cat", model: "sync" }))[0].mimeType, "video/mp4");
assert.equal((await generateVideos({ config, prompt: "cat", model: "b64" }))[0].mimeType, "video/mp4");
console.log("✓ synchronous data[].url and videos[].b64_json shapes");

// Failure paths
await assert.rejects(() => generateVideos({ config, prompt: "x", model: "unauthorized" }), (err) => {
  assert.match(err.message, /401/);
  assert.match(err.message, /apiKey/);
  return true;
});
await assert.rejects(() => generateVideos({ config, prompt: "x", model: "junk" }), /no video and no job id/);
await assert.rejects(() => generateVideos({ config, prompt: "x", model: "fail" }), /failed/);
await assert.rejects(
  () => generateVideos({ config: { ...config, model: "slow", pollTimeoutMs: 40, pollIntervalMs: 5 }, prompt: "x" }),
  /pollTimeoutMs/,
);
console.log("✓ 401, unusable responses, a failed job and a poll timeout");

const controller = new AbortController();
controller.abort();
await assert.rejects(() => generateVideos({ config, prompt: "x", signal: controller.signal }), /cancelled/);
console.log("✓ cancellation");

// apiKey: "codex" demands the codex credential rather than quietly going keyless
process.env.PI_TEXT2VIDEO_API_KEY = "codex";
const demanded = loadVideoConfig(cwd);
assert.equal(demanded.apiKeySource, "none");
assert.match(demanded.codexHint ?? "", /does not exist/);
delete process.env.PI_TEXT2VIDEO_API_KEY;
console.log("✓ apiKey \"codex\" reports the missing credential instead of an empty key");

// `config set` coercion
assert.equal(coerceVideoConfigValue("pollIntervalMs", "10"), 10);
assert.equal(coerceVideoConfigValue("useCodexAuth", "no"), false);
assert.equal(coerceVideoConfigValue("seconds", ""), "", "an empty string means do not send the field");
assert.deepEqual(coerceVideoConfigValue("extraBody", '{"seed":7}'), { seed: 7 });
assert.throws(() => coerceVideoConfigValue("nope", "1"), /unknown video config key/);
assert.throws(() => coerceVideoConfigValue("timeoutMs", "0"), /positive number/);
assert.throws(() => coerceVideoConfigValue("extraBody", "7"), /JSON object/);
console.log("✓ /video config set coercion rejects nonsense");

// Writing the video config, and reading it back: it stays separate from images
const target = path.join(cwd, ".pi", "text2video.json");
writeConfigPatch(target, { seconds: "8", extraBody: { seed: 7 } });
assert.equal(JSON.parse(fs.readFileSync(target, "utf-8")).seconds, "8");
delete process.env.PI_TEXT2VIDEO_EXTRA_BODY;
const reloaded = loadVideoConfig(cwd);
assert.equal(reloaded.seconds, "8");
assert.deepEqual(reloaded.extraBody, { seed: 7 });
assert.notEqual(fs.existsSync(path.join(cwd, ".pi", "text2image.json")), true, "writing the video config must not create an image config");
assert.equal(loadConfig(cwd).size, "1024x1024");
console.log("✓ video config file is written and read back independently");

const described = describeVideoConfig(config, cwd).join("\n");
assert.ok(described.includes("vide…5678") && !described.includes("video-key-5678"), "the video key must be redacted");
assert.ok(described.includes("text2video.json"));
console.log("✓ video config output is redacted");

api.close();
fs.rmSync(cwd, { recursive: true, force: true });
console.log("video.test.mjs passed\n");
