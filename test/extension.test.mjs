// The extension itself: feed it a fake ExtensionAPI / ExtensionContext and
// exercise the tool, the command and the renderers.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader, startFakeImagesApi } from "./pi-runtime.mjs";

const api = await startFakeImagesApi();
process.env.PI_TEXT2IMAGE_BASE_URL = api.baseUrl;
process.env.PI_TEXT2IMAGE_API_KEY = "sk-test-abcd1234";
process.env.PI_TEXT2IMAGE_MODEL = "b64";
delete process.env.PI_TEXT2IMAGE_EXTRA_BODY;
delete process.env.PI_TEXT2IMAGE_HEADERS;

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t2i-ext-"));
const loader = await createLoader();
const factory = await loader.import("extensions/text2image.ts", { default: true });

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

assert.deepEqual(tools.map((tool) => tool.name), ["generate_image"]);
assert.deepEqual([...commands.keys()], ["image"]);
assert.deepEqual([...renderers.keys()].sort(), ["text2image", "text2image-info"]);
console.log("✓ registers 1 tool, 1 command, 2 renderers");

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, italic: (text) => text };
const notices = [];
const statuses = [];
const makeCtx = (input) => ({
  cwd,
  hasUI: true,
  model: { input },
  ui: {
    notify: (message, level) => notices.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }),
    input: async () => "dialog prompt",
  },
});

const tool = tools[0];

// Text-only model: paths only, no base64 in context
const updates = [];
let result = await tool.execute("call-1", { prompt: "a red panda", n: 2 }, undefined, (update) => updates.push(update), makeCtx(["text"]));
assert.equal(result.content.filter((block) => block.type === "image").length, 0);
assert.equal(result.details.inlined, false);
assert.equal(result.details.files.length, 2);
assert.ok(result.content[0].text.includes("no image input"));
for (const file of result.details.files) assert.ok(fs.existsSync(file.path));
assert.match(updates[0].content[0].text, /Generating 2/);
console.log("✓ tool returns paths only for a text-only model");

// Provenance: which provider, which interface, which model produced these files
assert.equal(result.details.provider, "openai");
assert.equal(result.details.model, "b64");
assert.match(result.details.endpoint, /^POST http:\/\/127\.0\.0\.1:\d+\/v1\/images\/generations$/);
assert.match(result.content[0].text, /Provider: openai · model: b64/);
assert.match(result.content[0].text, /Interface: POST http:\/\/127\.0\.0\.1:\d+\/v1\/images\/generations/);
console.log("✓ tool result records provider, interface and model");

// Vision model: first two inlined, the rest still saved
result = await tool.execute("call-2", { prompt: "a red panda", n: 3 }, undefined, undefined, makeCtx(["text", "image"]));
const inlined = result.content.filter((block) => block.type === "image");
assert.equal(inlined.length, 2);
assert.equal(inlined[0].mimeType, "image/png");
assert.equal(Buffer.from(inlined[0].data, "base64").subarray(1, 4).toString(), "PNG");
assert.equal(result.details.inlined, true);
assert.equal(result.details.files.length, 3);
console.log("✓ tool inlines the first 2 images for a vision model");

// Renderers
assert.match(tool.renderCall({ prompt: "a red panda", size: "1024x1024", n: 2 }, theme, {}).render(80).join(""), /generate_image/);
const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, theme, { showImages: true }).render(80).join("\n");
assert.ok(rendered.includes("3 image(s)") && rendered.includes(result.details.files[0].path));
assert.ok(rendered.includes("openai") && rendered.includes("/v1/images/generations"), "the rendered result names the backend");
assert.match(tool.renderResult({ content: [], details: undefined }, { expanded: false, isPartial: true }, theme, { showImages: true }).render(80).join(""), /generating/);
console.log("✓ renderCall / renderResult");

// Failure is signalled by throwing (pi marks isError from a thrown error)
await assert.rejects(() => tool.execute("call-3", { prompt: "x", model: "unauthorized" }, undefined, undefined, makeCtx(["text"])), /401/);
console.log("✓ tool throws on failure");

// /image: quoted prompt plus flags
const command = commands.get("image");
await command.handler('a cat "in a hat" --n 2 --size 512x512', makeCtx(["text"]));
assert.equal(entries.at(-1).type, "text2image");
assert.equal(entries.at(-1).data.prompt, "a cat in a hat");
assert.equal(entries.at(-1).data.files.length, 2);
assert.equal(entries.at(-1).data.provider, "openai");
assert.match(entries.at(-1).data.endpoint, /images\/generations/);
assert.equal(entries.at(-1).data.model, "b64");
assert.equal(api.requests.at(-1).body.size, "512x512");
assert.deepEqual(statuses.at(-1), { key: "text2image", text: undefined }, "status must be cleared");
const card = renderers.get("text2image")(entries.at(-1), { expanded: false }, theme).render(80).join("\n");
assert.match(card, /a cat in a hat/);
assert.ok(card.includes("openai") && card.includes("/v1/images/generations"), "the /image card names the backend too");
console.log("✓ /image generates and appends a TUI entry");

await command.handler("", makeCtx(["text"]));
assert.equal(entries.at(-1).data.prompt, "dialog prompt");
console.log("✓ /image without arguments opens the input dialog");

await command.handler("config", makeCtx(["text"]));
const info = entries.at(-1);
assert.equal(info.type, "text2image-info");
const infoText = info.data.lines.join("\n");
assert.ok(infoText.includes("sk-t…1234") && !infoText.includes("sk-test-abcd1234"));
assert.ok(renderers.get("text2image-info")(info, { expanded: false }, theme).render(80).length > 0);
console.log("✓ /image config output is redacted");

await command.handler("x --model unauthorized", makeCtx(["text"]));
assert.equal(notices.at(-1).level, "error");
assert.match(notices.at(-1).message, /Text-to-image failed[\s\S]*401/);
assert.equal(statuses.at(-1).text, undefined);
console.log("✓ /image reports failure and clears status");

api.close();
fs.rmSync(cwd, { recursive: true, force: true });
console.log("extension.test.mjs passed\n");
