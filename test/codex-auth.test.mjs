// Reusing an existing codex login as the images API key.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader, startFakeImagesApi } from "./pi-runtime.mjs";

const api = await startFakeImagesApi();
const loader = await createLoader();
const { loadConfig, describeConfig, codexAuthPath, readCodexCredential } = await loader.import("src/config.ts");
const { generateImages } = await loader.import("src/images.ts");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t2i-codex-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));

function writeCodexAuth(payload) {
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(payload, null, 2));
}
function reset(env = {}) {
  for (const key of ["PI_TEXT2IMAGE_API_KEY", "OPENAI_API_KEY", "PI_TEXT2IMAGE_USE_CODEX_AUTH"]) delete process.env[key];
  process.env.CODEX_HOME = codexHome;
  process.env.PI_TEXT2IMAGE_BASE_URL = api.baseUrl;
  Object.assign(process.env, env);
}

reset();
assert.equal(codexAuthPath(), path.join(codexHome, "auth.json"));
assert.equal(readCodexCredential().exists, false);
assert.equal(loadConfig(cwd).apiKeySource, "none");
console.log("✓ no codex login: nothing imported, no noise");

// API-key login mode — the only codex state the images API can use
writeCodexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-codex-key-9876", tokens: null });
reset();
let config = loadConfig(cwd);
assert.equal(config.apiKey, "sk-codex-key-9876");
assert.equal(config.apiKeySource, "codex");
assert.equal(config.codexHint, undefined);
assert.match(describeConfig(config, cwd).join("\n"), /sk-c…9876 \(from .*auth\.json\)/);
console.log("✓ codex api-key login is imported and shown as its source");

// ChatGPT OAuth login — tokens are scoped to the Codex backend, unusable here
writeCodexAuth({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "eyJ-fake", account_id: "acc-1" } });
reset();
config = loadConfig(cwd);
assert.equal(config.apiKey, "");
assert.equal(config.apiKeySource, "none");
assert.match(config.codexHint, /ChatGPT account login/);
assert.match(config.codexHint, /codex login --with-api-key/);
assert.ok(describeConfig(config, cwd).join("\n").includes("ChatGPT account login"));
// and the reason reaches the user at call time, not just in /image config
await assert.rejects(() => generateImages({ config, prompt: "x", model: "unauthorized" }), (err) => {
  assert.match(err.message, /401/);
  assert.match(err.message, /ChatGPT account login/);
  return true;
});
console.log("✓ chatgpt login is refused with the reason, in config and in errors");

// Explicit configuration always wins
reset({ PI_TEXT2IMAGE_API_KEY: "sk-explicit-1111" });
writeCodexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-codex-key-9876" });
assert.equal(loadConfig(cwd).apiKey, "sk-explicit-1111");
assert.equal(loadConfig(cwd).apiKeySource, "config");

reset({ OPENAI_API_KEY: "sk-env-2222" });
assert.equal(loadConfig(cwd).apiKeySource, "openai-env");
console.log("✓ explicit config and OPENAI_API_KEY outrank codex");

// apiKey: "codex" demands the codex credential, ignoring OPENAI_API_KEY
reset({ PI_TEXT2IMAGE_API_KEY: "codex", OPENAI_API_KEY: "sk-env-2222" });
assert.equal(loadConfig(cwd).apiKey, "sk-codex-key-9876");
fs.rmSync(path.join(codexHome, "auth.json"));
config = loadConfig(cwd);
assert.equal(config.apiKey, "");
assert.match(config.codexHint, /does not exist/);
console.log('✓ apiKey: "codex" forces the codex credential and explains its absence');

// Opting out
writeCodexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-codex-key-9876" });
reset({ PI_TEXT2IMAGE_USE_CODEX_AUTH: "0" });
assert.equal(loadConfig(cwd).apiKeySource, "none");
console.log("✓ PI_TEXT2IMAGE_USE_CODEX_AUTH=0 disables the import");

api.close();
delete process.env.CODEX_HOME;
fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(codexHome, { recursive: true, force: true });
console.log("codex-auth.test.mjs passed\n");
