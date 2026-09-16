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
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.url === "/clip.mp4") {
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
  if (req.method === "POST" && req.url === "/v2/video_generation") {
    polls = 0;
    if (mode === "http-error") return json({ type: "error", error: { message: "insufficient balance" } }, 402);
    if (mode === "business-error") return json({ type: "error", error: { message: "invalid model" } });
    if (mode === "invalid-json") { res.end("not json"); return; }
    if (mode === "no-task") return json({});
    return json({ task_id: "task-123" });
  }
  if (req.url === "/v2/query/video_generation/task-123") {
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
