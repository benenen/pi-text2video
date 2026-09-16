// Config resolution and the images client: real requests against a local fake
// service, real files on disk.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader, startFakeImagesApi } from "./pi-runtime.mjs";

const api = await startFakeImagesApi();
process.env.PI_TEXT2IMAGE_BASE_URL = api.baseUrl;
process.env.PI_TEXT2IMAGE_API_KEY = "test-key-1234";
process.env.PI_TEXT2IMAGE_EXTRA_BODY = JSON.stringify({ negative_prompt: "blurry" });
process.env.PI_TEXT2IMAGE_HEADERS = JSON.stringify({ "x-gateway": "internal" });
delete process.env.PI_TEXT2IMAGE_SIZE;

const loader = await createLoader();
const { loadConfig, imagesEndpoint, resolveOutputDir, describeConfig, redactKey } = await loader.import("src/config.ts");
const { generateImages, saveImages, formatBytes, imageDimensions } = await loader.import("src/images.ts");

// Dimensions come from the file header, never from the requested size
{
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([3, 0, 5, 0])]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x07, 0x00, 0x09]), Buffer.alloc(9)]);
  const webp = Buffer.concat([
    Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from("VP8X"), Buffer.alloc(4),
    Buffer.from([0]), Buffer.alloc(3),
    Buffer.from([639 & 0xff, (639 >> 8) & 0xff, 0]), Buffer.from([479 & 0xff, (479 >> 8) & 0xff, 0]),
  ]);
  assert.deepEqual(imageDimensions(api.pngBuffer), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(gif), { width: 3, height: 5 });
  assert.deepEqual(imageDimensions(jpeg), { width: 9, height: 7 });
  assert.deepEqual(imageDimensions(webp), { width: 640, height: 480 });
  assert.equal(imageDimensions(Buffer.from("not an image")), undefined);
  assert.equal(imageDimensions(api.pngBuffer.subarray(0, 8)), undefined, "a truncated header reports nothing rather than guessing");
  console.log("✓ pixel dimensions parsed from png, gif, jpeg and webp headers");
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t2i-client-"));
const config = loadConfig(cwd);
assert.equal(imagesEndpoint(config), `${api.baseUrl}/images/generations`);
assert.equal(config.size, "1024x1024");
assert.equal(config.extraBody.negative_prompt, "blurry");
assert.equal(redactKey(config.apiKey), "test…1234");
assert.equal(resolveOutputDir(cwd, ".pi/images"), path.join(cwd, ".pi/images"));
console.log("✓ config resolution");

const outputDir = resolveOutputDir(cwd, config.outputDir);

// OpenAI shape: data[].b64_json
let images = await generateImages({ config, prompt: "a red panda drinking tea", model: "b64" });
assert.equal(images.length, 1);
assert.equal(images[0].mimeType, "image/png");
assert.equal(images[0].revisedPrompt, "a rewritten prompt");
let saved = saveImages(images, { outputDir, prompt: "a red panda drinking tea" });
assert.ok(fs.existsSync(saved[0].path));
assert.ok(saved[0].path.endsWith(".png"));
assert.equal(saved[0].bytes, api.pngBuffer.byteLength);
assert.equal(saved[0].width, 1);
assert.equal(saved[0].height, 1);
console.log("✓ data[].b64_json →", path.basename(saved[0].path), formatBytes(saved[0].bytes));

const last = api.requests.at(-1);
assert.equal(last.headers.authorization, "Bearer test-key-1234");
assert.equal(last.headers["x-gateway"], "internal");
assert.equal(last.body.size, "1024x1024");
assert.equal(last.body.negative_prompt, "blurry");
assert.equal(last.body.response_format, undefined, "response_format must stay unset by default: gpt-image-1 rejects it");
console.log("✓ request body and headers");

// Other common response shapes
assert.equal((await generateImages({ config, prompt: "cat", model: "url" }))[0].mimeType, "image/png");
assert.equal((await generateImages({ config, prompt: "cat", model: "dashscope" })).length, 1);
console.log("✓ images[].url and output.results shapes");

// Same prompt twice must not overwrite
images = await generateImages({ config, prompt: "cat", model: "b64" });
const first = saveImages([...images, ...images], { outputDir, prompt: "same prompt" });
const second = saveImages([...images, ...images], { outputDir, prompt: "same prompt" });
assert.equal(new Set([...first, ...second].map((file) => file.path)).size, 4);
console.log("✓ multiple outputs and name collisions");

// Failure paths
await assert.rejects(() => generateImages({ config, prompt: "x", model: "unauthorized" }), (err) => {
  assert.match(err.message, /401/);
  assert.match(err.message, /apiKey/);
  return true;
});
await assert.rejects(() => generateImages({ config, prompt: "x", model: "junk" }), /no image/);
console.log("✓ 401 and unparseable responses");

const controller = new AbortController();
controller.abort();
await assert.rejects(() => generateImages({ config, prompt: "x", model: "b64", signal: controller.signal }), /cancelled/);
await assert.rejects(() => generateImages({ config: { ...config, timeoutMs: 1, baseUrl: "http://127.0.0.1:9/v1" }, prompt: "x" }), /timed out|cannot reach/);
console.log("✓ cancellation and timeout");

// An explicitly empty size means the field is not sent
process.env.PI_TEXT2IMAGE_SIZE = "";
const noSize = loadConfig(cwd);
assert.equal(noSize.size, undefined);
await generateImages({ config: noSize, prompt: "x", model: "b64" });
assert.equal(api.requests.at(-1).body.size, undefined);
delete process.env.PI_TEXT2IMAGE_SIZE;
console.log("✓ empty size is not sent");

const described = describeConfig(config, cwd).join("\n");
assert.ok(described.includes("test…1234") && !described.includes("test-key-1234"));
console.log("✓ config output is redacted");

api.close();
fs.rmSync(cwd, { recursive: true, force: true });
console.log("client.test.mjs passed\n");
