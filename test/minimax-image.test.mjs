import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createLoader } from "./pi-runtime.mjs";

const loader = await createLoader();
const { loadConfig, imagesEndpoint, describeBackend } = await loader.import("src/config.ts");
const { generateImages, saveImages } = await loader.import("src/images.ts");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-image-"));
for (const key of Object.keys(process.env)) if (key.startsWith("PI_TEXT2IMAGE_") || key === "MINIMAX_API_KEY") delete process.env[key];
process.env.PI_TEXT2IMAGE_PROVIDER = "minimax";
process.env.OPENAI_API_KEY = "must-not-leak";
process.env.OPENAI_BASE_URL = "https://must-not-use.invalid";
let config = loadConfig(cwd);
assert.equal(config.provider, "minimax");
assert.equal(config.model, "image-01");
assert.equal(config.size, undefined);
assert.equal(config.apiKey, "");
assert.equal(imagesEndpoint(config), "https://api.minimax.cn/v1/image_generation");
await assert.rejects(generateImages({ config, prompt: "cat" }), /MINIMAX_API_KEY/);
process.env.MINIMAX_API_KEY = "test-minimax-key";
config = loadConfig(cwd);
assert.equal(config.apiKeySource, "minimax-env");
assert.equal(describeBackend(config).label, "minimax");
for (const suffix of ["", "/v1", "/v1/image_generation"]) assert.equal(imagesEndpoint({ ...config, baseUrl: `https://example.com${suffix}` }), "https://example.com/v1/image_generation");
process.env.PI_TEXT2IMAGE_API_KEY = "override-key";
assert.equal(loadConfig(cwd).apiKey, "override-key");
delete process.env.PI_TEXT2IMAGE_API_KEY;

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const requests = [];
let mode = "base64";
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
  if (req.url === "/file.png") return res.end(png);
  if (mode === "http") { res.writeHead(401); return res.end("unauthorized"); }
  if (mode === "json") return res.end("not JSON");
  if (mode === "error") return res.end(JSON.stringify({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }));
  const data = mode === "empty" ? {} : mode === "url" ? { image_urls: [`http://127.0.0.1:${server.address().port}/file.png`] } : { image_base64: Array(requests.at(-1).body.n).fill(png.toString("base64")) };
  res.end(JSON.stringify({ data, base_resp: { status_code: 0 } }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
config = { ...config, baseUrl: `http://127.0.0.1:${server.address().port}`, headers: { "x-private": "secret" }, extraBody: { seed: 42 } };
try {
  const images = await generateImages({ config, prompt: "cat", size: "16:9", n: 2 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/v1/image_generation");
  assert.equal(requests[0].headers.authorization, "Bearer test-minimax-key");
  assert.deepEqual(requests[0].body, { prompt_optimizer: false, seed: 42, model: "image-01", prompt: "cat", n: 2, response_format: "base64", aspect_ratio: "16:9" });
  assert.equal(images.length, 2);
  const saved = saveImages(images, { outputDir: cwd, prompt: "cat" });
  assert.deepEqual(fs.readFileSync(saved[0].path), png);
  await generateImages({ config: { ...config, extraBody: { prompt_optimizer: true, aspect_ratio: "1:1" } }, prompt: "cat", size: "1024x768" });
  assert.equal(requests.at(-1).body.width, 1024);
  assert.equal(requests.at(-1).body.height, 768);
  assert.equal(requests.at(-1).body.aspect_ratio, undefined);
  assert.equal(requests.at(-1).body.prompt_optimizer, true);
  mode = "url";
  const downloaded = await generateImages({ config: { ...config, responseFormat: "url" }, prompt: "cat" });
  assert.deepEqual(downloaded[0].data, png);
  assert.equal(requests.at(-1).headers.authorization, undefined);
  assert.equal(requests.at(-1).headers["x-private"], undefined);
  for (const [failure, pattern] of [["error", /1008.*insufficient balance/], ["empty", /no images/], ["http", /401/], ["json", /invalid JSON/]]) {
    mode = failure;
    await assert.rejects(generateImages({ config, prompt: "cat" }), pattern);
  }
  const count = requests.length;
  for (const options of [{ n: 10 }, { n: 1.5 }, { size: "513x1024" }, { size: "2:1" }, { prompt: " " }, { prompt: "x".repeat(1501) }]) {
    await assert.rejects(generateImages({ config, prompt: "cat", ...options }), /MiniMax/);
  }
  assert.equal(requests.length, count);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateImages({ config, prompt: "cat", signal: controller.signal }), /cancelled/);
  console.log("✓ MiniMax images: config, one generation call, base64, download, saving, optimizer, validation and failures");
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(cwd, { recursive: true, force: true });
}
