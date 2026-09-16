// The codex provider: `codex exec` is replaced by a fake binary, so the test
// covers our side of the contract — arguments, file collection, failures.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader } from "./pi-runtime.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bin-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t2i-codex-be-"));
const generatedDir = path.join(codexHome, "generated_images");
const argsLog = path.join(bin, "args.txt");

/** A stand-in for `codex exec`: records its arguments, writes PNGs where Codex would. */
function writeFakeCodex(name, body) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsLog}"\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const happy = writeFakeCodex(
  "codex-ok",
  `mkdir -p "${generatedDir}/session-1"
cp "${path.join(bin, "seed.png")}" "${generatedDir}/session-1/exec-a.png"
cp "${path.join(bin, "seed.png")}" "${generatedDir}/session-1/exec-b.png"
echo "${generatedDir}/session-1/exec-a.png"
echo "${generatedDir}/session-1/exec-b.png"`,
);
const failing = writeFakeCodex("codex-fail", 'echo "image_gen tool unavailable" >&2\nexit 1');
fs.writeFileSync(path.join(bin, "seed.png"), PNG);

// An older image that must not be mistaken for this run's output.
fs.mkdirSync(path.join(generatedDir, "old-session"), { recursive: true });
const stale = path.join(generatedDir, "old-session", "stale.png");
fs.writeFileSync(stale, PNG);
fs.utimesSync(stale, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));

process.env.CODEX_HOME = codexHome;
process.env.PI_TEXT2IMAGE_PROVIDER = "codex";
process.env.PI_TEXT2IMAGE_CODEX_MODE = "cli";
process.env.PI_TEXT2IMAGE_CODEX_COMMAND = happy;
process.env.PI_TEXT2IMAGE_CODEX_MODEL = "gpt-5.1-codex";
delete process.env.PI_TEXT2IMAGE_TIMEOUT_MS;

const loader = await createLoader();
const { loadConfig, describeConfig, describeBackend, codexGeneratedImagesDir } = await loader.import("src/config.ts");
const { generateImages, saveImages } = await loader.import("src/images.ts");

const config = loadConfig(cwd);
assert.equal(config.provider, "codex");
assert.equal(config.codexMode, "cli");
assert.equal(config.apiKey, "", "the codex provider must not carry a key");
assert.equal(config.codexHint, undefined, "a ChatGPT login is the normal case here, not a problem to report");
assert.equal(config.timeoutMs, 600_000, "an agent turn needs a longer default than one HTTP call");
assert.equal(codexGeneratedImagesDir(), generatedDir);
const described = describeConfig(config, cwd).join("\n");
assert.match(described, /provider {3}codex\/cli/);
assert.match(described, /no tokens read/);
const backendDescription = describeBackend(config);
assert.equal(backendDescription.label, "codex/cli");
assert.equal(backendDescription.model, "gpt-5.1-codex");
assert.match(backendDescription.endpoint, /exec \(tool: image_gen\)$/);
console.log("✓ codex provider config: no key, longer timeout, own config view");

let images = await generateImages({ config, prompt: "a red panda drinking tea", n: 2, size: "1024x1024" });
assert.equal(images.length, 2);
assert.equal(images[0].mimeType, "image/png");
assert.equal(images[0].ext, "png");
assert.ok(images[0].data.equals(PNG));
console.log("✓ collects the images codex wrote, ignoring older ones");

// The prompt is multi-line, so flags are checked per line and the prompt as a whole.
const argsText = fs.readFileSync(argsLog, "utf-8");
const args = argsText.split("\n");
assert.equal(args[0], "exec");
assert.ok(args.includes("--skip-git-repo-check") && args.includes("--ephemeral"));
assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
assert.equal(args[args.indexOf("-m") + 1], "gpt-5.1-codex");
assert.match(argsText, /built-in image_gen tool/);
assert.match(argsText, /Image prompt: a red panda drinking tea/);
assert.match(argsText, /Target size: 1024x1024/);
assert.match(argsText, /never ask for an OPENAI_API_KEY/);
console.log("✓ codex exec is invoked non-interactively, sandboxed, with the built-in-tool prompt");

// Only one image requested: the newest one wins
images = await generateImages({ config, prompt: "one", n: 1 });
assert.equal(images.length, 1);
const saved = saveImages(images, { outputDir: path.join(cwd, "out"), prompt: "one" });
assert.ok(fs.existsSync(saved[0].path));
console.log("✓ saving works the same as for the openai provider");

// Failures: codex exits non-zero, and codex is missing entirely
const failingConfig = { ...config, codexCommand: failing };
fs.rmSync(generatedDir, { recursive: true, force: true });
await assert.rejects(() => generateImages({ config: failingConfig, prompt: "x" }), (err) => {
  assert.match(err.message, /produced no image/);
  assert.match(err.message, /image_gen tool unavailable/);
  assert.match(err.message, /codex login status/);
  return true;
});
await assert.rejects(() => generateImages({ config: { ...config, codexCommand: "codex-that-does-not-exist" }, prompt: "x" }), /not found on PATH/);
console.log("✓ failure messages name the cause");

for (const dir of [codexHome, bin, cwd]) fs.rmSync(dir, { recursive: true, force: true });
delete process.env.PI_TEXT2IMAGE_CODEX_MODE;
delete process.env.CODEX_HOME;
delete process.env.PI_TEXT2IMAGE_PROVIDER;
delete process.env.PI_TEXT2IMAGE_CODEX_COMMAND;
delete process.env.PI_TEXT2IMAGE_CODEX_MODEL;
console.log("codex-backend.test.mjs passed\n");
