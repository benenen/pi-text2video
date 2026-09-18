import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createLoader } from "./pi-runtime.mjs";

const loader = await createLoader();
const { loadVideoConfig, describeVideoBackend, describeVideoConfig, videosEndpoint, videoStatusEndpoint, coerceVideoConfigValue } = await loader.import("src/config.ts");
const { generateVideos, saveVideos } = await loader.import("src/videos.ts");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-video-"));
for (const key of Object.keys(process.env)) if (key.startsWith("PI_TEXT2VIDEO_") || key === "MINIMAX_API_KEY") delete process.env[key];
process.env.PI_TEXT2VIDEO_PROVIDER = "minimax";
process.env.OPENAI_API_KEY = "must-not-leak";
process.env.OPENAI_BASE_URL = "https://must-not-use.invalid/v1";
let config = loadVideoConfig(cwd);
assert.equal(config.provider, "minimax");
assert.equal(config.baseUrl, "https://api.minimax.cn");
assert.equal(config.apiKey, "");
assert.equal(config.model, "MiniMax-H3");
assert.equal(config.size, "768P");
assert.equal(videosEndpoint(config), "https://api.minimax.cn/v2/video_generation");
process.env.MINIMAX_API_KEY = "minimax-test-key";
config = loadVideoConfig(cwd);
assert.equal(config.apiKey, "minimax-test-key");
assert.equal(config.apiKeySource, "minimax-env");
assert.ok(!describeVideoConfig(config, cwd).join("\n").includes("minimax-test-key"));
assert.equal(coerceVideoConfigValue("provider", "minimax"), "minimax");
assert.throws(() => coerceVideoConfigValue("provider", "typo"), /provider/);
for (const suffix of ["", "/v1", "/v2", "/v2/video_generation"]) {
  const variant = { ...config, baseUrl: `https://example.com${suffix}` };
  assert.equal(videosEndpoint(variant), "https://example.com/v2/video_generation");
  assert.equal(videoStatusEndpoint(variant, "id/a"), "https://example.com/v2/query/video_generation/id%2Fa");
}
console.log("✓ MiniMax config, isolated credentials, redaction and endpoints");

const requests = [];
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(20)]);
let mode = "success", polls = 0;
let downloadController;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
  const route = req.url.replace(/^\/api\/minimax/, "");
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (route === "/clip.mp4") {
    if (mode === "download-fail") return json({ error: "unavailable" }, 503);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    if (mode === "slow-download" || mode === "abort-download") {
      res.flushHeaders();
      if (mode === "abort-download") setTimeout(() => downloadController.abort(), 5);
      setTimeout(() => res.end(mp4), 100);
      return;
    }
    return res.end(mode === "empty" ? Buffer.alloc(0) : mp4);
  }
  if (req.method === "POST" && route === "/v2/video_generation") {
    polls = 0;
    if (mode === "http-error") return json({ type: "error", error: { message: "insufficient balance" } }, 402);
    if (mode === "business-error") return json({ type: "error", error: { message: "invalid model" } });
    if (mode === "invalid-json") { res.end("not json"); return; }
    if (mode === "no-task") return json({});
    return json({ task_id: "task-123" });
  }
  if (route === "/v2/query/video_generation/task-123") {
    polls++;
    if (mode === "slow") { setTimeout(() => json({ task: { status: "running" } }), 100); return; }
    if (["failed", "cancelled", "expired"].includes(mode)) return json({ task: { status: mode, error: { message: "task rejected" } } });
    if (mode === "no-url") return json({ task: { status: "succeeded", content: {} } });
    if (mode === "no-status") return json({ task: {} });
    if (mode === "pending" || polls === 1) return json({ task: { status: "running" } });
    return json({ task: { status: "succeeded", content: { url: `http://127.0.0.1:${server.address().port}/clip.mp4` } } });
  }
  json({ error: "wrong endpoint" }, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
config = { ...config, baseUrl: `http://127.0.0.1:${server.address().port}`, pollIntervalMs: 2, pollTimeoutMs: 500, timeoutMs: 200, headers: { "x-test": "custom" }, extraBody: { ratio: "9:16" } };
try {
  const progress = [];
  const videos = await generateVideos({ config, prompt: "a boat", seconds: "8", size: "2K", onProgress: (message) => progress.push(message) });
  assert.deepEqual(requests[0].body, { model: "MiniMax-H3", content: [{ type: "text", text: "a boat" }], resolution: "2K", duration: 8, ratio: "9:16" });
  for (const req of requests.filter((req) => req.url !== "/clip.mp4")) {
    assert.equal(req.headers.authorization, "Bearer minimax-test-key");
    assert.equal(req.headers["x-test"], "custom");
  }
  assert.equal(requests.at(-1).headers.authorization, undefined, "CDN requests must not receive API credentials");
  assert.equal(requests.at(-1).headers["x-test"], undefined);
  assert.ok(progress.some((text) => text.includes("running")));
  assert.deepEqual(videos[0].data, mp4);
  const saved = saveVideos(videos, { outputDir: cwd, prompt: "a boat" });
  assert.ok(fs.existsSync(saved[0].path));
  assert.equal(describeVideoBackend(config).label, "minimax");
  console.log("✓ H3 submit → authenticated polling → credential-free download → save");

  const firstFrame = "https://example.com/start.png";
  const lastFrame = "https://example.com/end.jpg";
  const latestBody = () => requests.filter((req) => req.method === "POST").at(-1).body;
  for (const frames of [{ firstFrame }, { lastFrame }, { firstFrame, lastFrame }]) {
    const generated = await generateVideos({ config, prompt: "Waves roll in, with ocean sounds and soft piano.", ...frames });
    assert.deepEqual(latestBody().content, [
      { type: "text", text: "Waves roll in, with ocean sounds and soft piano." },
      ...(frames.firstFrame ? [{ type: "image_url", image_url: { url: firstFrame }, role: "first_frame" }] : []),
      ...(frames.lastFrame ? [{ type: "image_url", image_url: { url: lastFrame }, role: "last_frame" }] : []),
    ]);
    assert.equal(latestBody().ratio, "adaptive", "image aspect ratio overrides the text-to-video setting");
    assert.equal(latestBody().audio, undefined, "H3 has no separate audio flag");
    assert.deepEqual(generated[0].data, mp4, "downloaded media is preserved byte-for-byte");
  }
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
  const imagePath = path.join(cwd, "first frame.png");
  fs.writeFileSync(imagePath, png);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  await generateVideos({ config, prompt: "x", cwd, firstFrame: "first frame.png", lastFrame: dataUrl });
  assert.equal(latestBody().content[1].image_url.url, dataUrl);
  assert.equal(latestBody().content[2].image_url.url, dataUrl);
  const beforeInvalid = requests.length;
  await assert.rejects(() => generateVideos({ config, prompt: "x", cwd, firstFrame: "missing.png" }), /image|ENOENT/i);
  await assert.rejects(() => generateVideos({ config, prompt: "x", firstFrame: " " }), /image|empty/i);
  await assert.rejects(() => generateVideos({ config, prompt: "x", firstFrame: "data:image/gif;base64,R0lGODlh" }), /image|format/i);
  await assert.rejects(() => generateVideos({ config, prompt: "x", firstFrame: "data:image/png;base64,!!!" }), /base64/i);
  await assert.rejects(() => generateVideos({ config, prompt: "x", firstFrame: "ftp://example.com/a.png" }), /URL|protocol/i);
  await assert.rejects(() => generateVideos({ config: { ...config, provider: "openai" }, prompt: "x", firstFrame }), /MiniMax|unsupported/i);
  const largeFile = path.join(cwd, "large.png");
  fs.writeFileSync(largeFile, png);
  fs.truncateSync(largeFile, 30 * 1024 * 1024 + 1);
  await assert.rejects(() => generateVideos({ config, prompt: "x", firstFrame: largeFile }), /30 MB/);
  assert.equal(requests.length, beforeInvalid, "invalid inputs must fail before creating a paid task");
  console.log("✓ first/last frames, local and data URL images, adaptive ratio and input validation");

  process.env.PI_TEXT2VIDEO_BASE_URL = config.baseUrl;
  process.env.PI_TEXT2VIDEO_POLL_INTERVAL_MS = "2";
  const factory = await loader.import("extensions/text2video.ts", { default: true });
  let tool, command;
  const entries = [], notices = [];
  factory({ registerTool: (value) => tool = value, registerCommand: (_name, value) => command = value, registerEntryRenderer: () => {}, appendEntry: (type, data) => entries.push({ type, data }) });
  const ctx = { cwd, hasUI: true, ui: { setStatus: () => {}, notify: (message, level) => notices.push({ message, level }) } };
  assert.ok(tool.parameters.properties.firstFrame && tool.parameters.properties.lastFrame);
  const result = await tool.execute("i2v", { prompt: "A boat moves with splashing sounds", firstFrame: "first frame.png", lastFrame }, undefined, undefined, ctx);
  assert.equal(latestBody().content[1].image_url.url, dataUrl);
  assert.equal(latestBody().content[2].image_url.url, lastFrame);
  assert.equal(result.details.provider, "minimax");
  await command.handler('a boat --first-frame "first frame.png" --last-frame=https://example.com/end.jpg --seconds 8', ctx);
  assert.equal(latestBody().content[0].text, "a boat");
  assert.equal(latestBody().content[1].image_url.url, dataUrl);
  assert.equal(latestBody().content[2].image_url.url, lastFrame);
  assert.equal(entries.at(-1).type, "text2video");
  await command.handler('a boat --first-frame="first frame.png"', ctx);
  assert.equal(latestBody().content[1].image_url.url, dataUrl);
  assert.equal(latestBody().content.length, 2);
  await command.handler("a person's boat --last-frame https://example.com/end.jpg", ctx);
  assert.equal(latestBody().content[0].text, "a person's boat");
  assert.equal(latestBody().content[1].role, "last_frame");
  const beforeMissingFlag = requests.length;
  await command.handler("a boat --first-frame --seconds 8", ctx);
  assert.equal(notices.at(-1).level, "error");
  assert.match(notices.at(-1).message, /first-frame.*value/);
  assert.equal(requests.length, beforeMissingFlag);
  assert.ok(command.getArgumentCompletions("--first").some((item) => item.value === "--first-frame "));
  console.log("✓ image inputs reach MiniMax through both the tool and manual command");

  const referenceVideo = "https://example.com/reference.mp4";
  const referenceAudio = "https://example.com/voice.mp3";
  const multimodalPrompt = "角色说话：Follow the wind, live free. 音色参考音频1";
  await generateVideos({ config, prompt: multimodalPrompt, size: "2K", seconds: "5", ratio: "adaptive", referenceVideos: [referenceVideo], referenceAudios: [referenceAudio] });
  assert.deepEqual(latestBody(), {
    model: "MiniMax-H3",
    content: [
      { type: "text", text: multimodalPrompt },
      { type: "video_url", video_url: { url: referenceVideo }, role: "reference_video" },
      { type: "audio_url", audio_url: { url: referenceAudio }, role: "reference_audio" },
    ],
    resolution: "2K", duration: 5, ratio: "adaptive",
  });
  await generateVideos({ config: { ...config, extraBody: {} }, prompt: "x", referenceImages: [firstFrame, lastFrame] });
  assert.equal(latestBody().ratio, "adaptive");
  assert.deepEqual(latestBody().content.slice(1).map((item) => item.image_url.url), [firstFrame, lastFrame]);
  assert.ok(latestBody().content.slice(1).every((item) => item.role === "reference_image"));
  await generateVideos({ config, prompt: "x", ratio: "4:3", referenceVideos: [referenceVideo] });
  assert.equal(latestBody().ratio, "4:3");
  const localVideo = path.join(cwd, "reference video.mp4");
  const localAudio = path.join(cwd, "reference audio.mp3");
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(16)]);
  fs.writeFileSync(localVideo, mp4);
  fs.writeFileSync(localAudio, mp3);
  await generateVideos({ config, cwd, prompt: "x", referenceImages: ["first frame.png"], referenceVideos: ["reference video.mp4"], referenceAudios: ["reference audio.mp3"] });
  assert.equal(latestBody().content[1].image_url.url, dataUrl);
  assert.equal(latestBody().content[2].video_url.url, `data:video/mp4;base64,${mp4.toString("base64")}`);
  assert.equal(latestBody().content[3].audio_url.url, `data:audio/mpeg;base64,${mp3.toString("base64")}`);
  await generateVideos({ config, prompt: "x", referenceVideos: [referenceVideo], referenceAudios: [`data:audio/mpeg;base64,${mp3.toString("base64")}`] });
  const beforeBadReferences = requests.length;
  for (const params of [
    { firstFrame, referenceVideos: [referenceVideo] },
    { lastFrame, referenceAudios: [referenceAudio] },
    { referenceImages: Array(10).fill(firstFrame) },
    { referenceVideos: Array(4).fill(referenceVideo) },
    { referenceAudios: Array(4).fill(referenceAudio) },
    { referenceImages: Array(9).fill(firstFrame), referenceVideos: Array(3).fill(referenceVideo), referenceAudios: [referenceAudio] },
    { referenceVideos: [referenceVideo], ratio: "nonsense" },
    { referenceVideos: ["data:audio/mpeg;base64,SUQz"] },
    { referenceAudios: [" "] },
  ]) await assert.rejects(() => generateVideos({ config, prompt: "x", ...params }), /reference|frame|ratio|format|empty|limit/i);
  await assert.rejects(() => generateVideos({ config: { ...config, provider: "openai" }, prompt: "x", referenceVideos: [referenceVideo] }), /MiniMax/);
  const bigAudio = path.join(cwd, "big.mp3");
  fs.writeFileSync(bigAudio, mp3); fs.truncateSync(bigAudio, 15 * 1024 * 1024 + 1);
  await assert.rejects(() => generateVideos({ config, prompt: "x", referenceVideos: [referenceVideo], referenceAudios: [bigAudio] }), /15 MB/);
  assert.equal(requests.length, beforeBadReferences);
  assert.ok(tool.parameters.properties.referenceVideos && tool.parameters.properties.referenceAudios && tool.parameters.properties.ratio);
  await tool.execute("multi", { prompt: multimodalPrompt, referenceVideos: [referenceVideo], referenceAudios: [referenceAudio], ratio: "adaptive", seconds: "5", size: "2K" }, undefined, undefined, ctx);
  assert.equal(latestBody().content[1].role, "reference_video");
  assert.equal(latestBody().content[2].role, "reference_audio");
  await command.handler('a person speaks --reference-image "first frame.png" --reference-image https://example.com/second.png --reference-video="reference video.mp4" --reference-audio "reference audio.mp3" --ratio adaptive', ctx);
  assert.equal(latestBody().content.length, 5);
  assert.equal(latestBody().content[2].image_url.url, "https://example.com/second.png");
  assert.equal(latestBody().content[3].role, "reference_video");
  assert.equal(latestBody().content[4].role, "reference_audio");
  assert.equal(latestBody().ratio, "adaptive");
  assert.ok(command.getArgumentCompletions("--reference").length === 3);
  console.log("✓ multimodal reference content, ordering, local media, limits, tool and command");

  // Preserve a gateway path prefix when creating and polling a task.
  for (const suffix of ["", "/v2", "/v2/video_generation"]) {
    const gateway = { ...config, baseUrl: `https://metaso.cn/api/minimax${suffix}` };
    assert.equal(videosEndpoint(gateway), "https://metaso.cn/api/minimax/v2/video_generation");
    assert.equal(videoStatusEndpoint(gateway, "task-123"), "https://metaso.cn/api/minimax/v2/query/video_generation/task-123");
  }

  const gatewayStart = requests.length;
  await generateVideos({ config: { ...config, baseUrl: `${config.baseUrl}/api/minimax/v2/video_generation` }, prompt: multimodalPrompt, referenceVideos: [referenceVideo], referenceAudios: [referenceAudio], ratio: "adaptive" });
  const gatewayRequests = requests.slice(gatewayStart);
  assert.equal(gatewayRequests[0].url, "/api/minimax/v2/video_generation");
  assert.equal(gatewayRequests[1].url, "/api/minimax/v2/query/video_generation/task-123");
  assert.equal(gatewayRequests[1].headers.authorization, "Bearer minimax-test-key");
  assert.equal(gatewayRequests.at(-1).headers.authorization, undefined);
  console.log("✓ gateway prefix retained for generation and authenticated polling");

  for (const [next, pattern] of [["http-error", /402.*insufficient balance/s], ["business-error", /invalid model/], ["invalid-json", /JSON/], ["no-task", /task_id/], ["failed", /failed.*task rejected/s], ["cancelled", /cancelled/], ["expired", /expired/], ["no-url", /URL/], ["no-status", /status/], ["download-fail", /503/], ["empty", /empty|zero bytes/]]) {
    mode = next;
    await assert.rejects(() => generateVideos({ config, prompt: "x" }), pattern, next);
  }
  mode = "pending";
  await assert.rejects(() => generateVideos({ config: { ...config, pollTimeoutMs: 15 }, prompt: "x" }), /timed out|still/);
  mode = "slow";
  await assert.rejects(() => generateVideos({ config: { ...config, timeoutMs: 10 }, prompt: "x" }), /timed out/);
  mode = "slow-download";
  await assert.rejects(() => generateVideos({ config: { ...config, timeoutMs: 15 }, prompt: "x" }), /timed out/);
  mode = "abort-download";
  downloadController = new AbortController();
  await assert.rejects(() => generateVideos({ config, prompt: "x", signal: downloadController.signal }), /cancelled/);
  const controller = new AbortController();
  controller.abort();
  const count = requests.length;
  await assert.rejects(() => generateVideos({ config, prompt: "x", signal: controller.signal }), /cancelled/);
  assert.equal(requests.length, count);
  mode = "pending";
  const duringPoll = new AbortController();
  await assert.rejects(() => generateVideos({ config, prompt: "x", signal: duringPoll.signal, onProgress: () => duringPoll.abort() }), /cancelled/);
  for (const seconds of ["3", "16", "5.5", "bad"]) await assert.rejects(() => generateVideos({ config, prompt: "x", seconds }), /duration|seconds/);
  await assert.rejects(() => generateVideos({ config, prompt: "x", size: "1280x720" }), /resolution|size/);
  await assert.rejects(() => generateVideos({ config: { ...config, apiKey: "" }, prompt: "x" }), /API key|apiKey/);
  console.log("✓ API/task/download errors, request/job timeouts, cancellation and validation");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(cwd, { recursive: true, force: true });
}
