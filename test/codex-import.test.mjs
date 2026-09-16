// `/image config import codex`: what it reads, what it probes, what it writes.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader } from "./pi-runtime.mjs";

function fakeJwt(seconds) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + seconds })}.sig`;
}

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t2i-import-"));
const writeAuth = (payload) => fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(payload, null, 2));

let acceptedModel = "gpt-5.6";
const unrelated400 = new Set();
const probed = [];
const backend = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    probed.push(parsed.model);
    if (unrelated400.has(parsed.model)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }));
      return;
    }
    if (parsed.model !== acceptedModel) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: `The '${parsed.model}' model is not supported when using Codex with a ChatGPT account.` }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`);
  });
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));

process.env.CODEX_HOME = codexHome;
process.env.PI_TEXT2IMAGE_CODEX_BASE_URL = `http://127.0.0.1:${backend.address().port}`;
for (const key of ["PI_TEXT2IMAGE_PROVIDER", "PI_TEXT2IMAGE_CODEX_MODE", "PI_TEXT2IMAGE_CODEX_API_MODEL"]) delete process.env[key];

const loader = await createLoader(); // also points HOME at a temp directory
const { loadConfig, userConfigPath, projectConfigPath } = await loader.import("src/config.ts");
const { planCodexImport, applyCodexImport, describeChanges } = await loader.import("src/codex-import.ts");

// No login at all
await assert.rejects(() => planCodexImport({ config: loadConfig(cwd), cwd }), /no codex login[\s\S]*codex login/);
console.log("✓ no codex login is refused with the fix");

// API-key login: point at auth.json, copy nothing
writeAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-from-codex-1234" });
probed.length = 0;
let plan = await planCodexImport({ config: loadConfig(cwd), cwd });
assert.deepEqual(plan.patch, { provider: "openai", apiKey: "codex" });
assert.equal(probed.length, 0, "an API-key login needs no probing");
assert.ok(!JSON.stringify(plan).includes("sk-from-codex-1234"), "the key itself must not be copied into the plan");
console.log("✓ api-key login imports as provider openai with apiKey \"codex\"");

// ChatGPT login: probe until a model is accepted
writeAuth({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: fakeJwt(3600), account_id: "acct-1", refresh_token: "rt" } });
probed.length = 0;
const progress = [];
plan = await planCodexImport({ config: loadConfig(cwd), cwd, onProgress: (message) => progress.push(message) });
assert.deepEqual(plan.patch, { provider: "codex", codexMode: "api", codexApiModel: "gpt-5.6" });
assert.deepEqual(probed, ["gpt-6-astra", "gpt-5.6"], "candidates are tried in order and stop at the first that works");
assert.ok(plan.notes.some((note) => /gpt-6-astra rejected \(400/.test(note)));
assert.ok(plan.notes.some((note) => /ChatGPT account login/.test(note)));
assert.ok(progress.length >= 2 && progress[0].includes("gpt-6-astra"));
console.log("✓ chatgpt login probes models and records what was rejected");

// --no-probe keeps the configured model and touches nothing
probed.length = 0;
plan = await planCodexImport({ config: loadConfig(cwd), cwd, probe: false });
assert.equal(plan.patch.codexApiModel, "gpt-6-astra");
assert.equal(probed.length, 0);
console.log("✓ --no-probe issues no requests");

// A 400 about something other than the model must not rule the model out
unrelated400.add("gpt-6-astra");
probed.length = 0;
plan = await planCodexImport({ config: loadConfig(cwd), cwd });
assert.equal(plan.patch.codexApiModel, "gpt-6-astra", "an unrelated 400 keeps the model");
assert.equal(plan.patch.codexMode, "api");
assert.ok(plan.warnings.some((warning) => /inconclusive[\s\S]*max_output_tokens/.test(warning)));
assert.deepEqual(probed, ["gpt-6-astra"], "an inconclusive probe stops the loop");
unrelated400.clear();
console.log("✓ an unrelated 400 is not read as \"model unsupported\"");

// Nothing accepted → fall back to cli mode with a warning
acceptedModel = "none-of-them";
plan = await planCodexImport({ config: loadConfig(cwd), cwd });
assert.equal(plan.patch.codexMode, "cli");
assert.ok(plan.warnings.some((warning) => /falling back to codexMode "cli"/.test(warning)));
acceptedModel = "gpt-5.6";
console.log("✓ no usable model falls back to cli mode");

// Writing merges with what is already there
fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
fs.writeFileSync(userConfigPath(), JSON.stringify({ outputDir: "~/Pictures/pi", provider: "openai" }, null, 2));
plan = await planCodexImport({ config: loadConfig(cwd), cwd });
const applied = applyCodexImport(plan);
assert.equal(applied.path, userConfigPath());
const written = JSON.parse(fs.readFileSync(userConfigPath(), "utf-8"));
assert.equal(written.outputDir, "~/Pictures/pi", "unrelated settings survive");
assert.equal(written.provider, "codex");
assert.equal(written.codexApiModel, "gpt-5.6");
const changes = describeChanges(applied.before, applied.after);
assert.ok(changes.some((line) => line.startsWith('provider: "openai" → "codex"')));
assert.ok(!changes.some((line) => line.startsWith("outputDir")), "unchanged keys are not listed");
assert.equal(loadConfig(cwd).provider, "codex", "the new config takes effect immediately");
console.log("✓ writing merges, reports only real changes, and takes effect");

// Project scope
plan = await planCodexImport({ config: loadConfig(cwd), cwd, scope: "project", probe: false });
assert.equal(plan.target, projectConfigPath(cwd));
applyCodexImport(plan);
assert.ok(fs.existsSync(projectConfigPath(cwd)));
fs.rmSync(projectConfigPath(cwd));
console.log("✓ --project writes the project config instead");

// The command itself
fs.rmSync(userConfigPath());
const factory = await loader.import("extensions/text2image.ts", { default: true });
const entries = [];
const notices = [];
const commands = new Map();
factory({
  registerTool: () => {},
  registerCommand: (name, options) => commands.set(name, options),
  registerEntryRenderer: () => {},
  appendEntry: (type, data) => entries.push({ type, data }),
});
await commands.get("image").handler("config import codex", {
  cwd,
  hasUI: false,
  model: { input: ["text"] },
  ui: { notify: (message, level) => notices.push({ message, level }), setStatus: () => {}, input: async () => "" },
});
assert.equal(entries.at(-1).type, "text2image-info");
assert.match(entries.at(-1).data.title, /imported codex login/);
assert.ok(fs.existsSync(userConfigPath()));
assert.equal(JSON.parse(fs.readFileSync(userConfigPath(), "utf-8")).codexApiModel, "gpt-5.6");
assert.equal(notices.length, 0, "a successful import reports through the entry, not a notification");
console.log("✓ /image config import codex writes the config and reports what it did");

backend.close();
for (const dir of [codexHome, cwd]) fs.rmSync(dir, { recursive: true, force: true });
delete process.env.CODEX_HOME;
delete process.env.PI_TEXT2IMAGE_CODEX_BASE_URL;
console.log("codex-import.test.mjs passed\n");
