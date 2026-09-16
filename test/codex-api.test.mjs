// codexMode "api": the Codex backend and the token endpoint are replaced by
// local servers, so this covers the request we send, the SSE we parse, and the
// refresh dance — everything except the real endpoint's behaviour.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader } from "./pi-runtime.mjs";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A JWT with only what the expiry check reads. */
function fakeJwt(expSecondsFromNow, claims = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, ...claims })}.sig`;
}

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t2i-api-"));
function writeAuth(payload) {
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(payload, null, 2));
}

const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const imageItem = { type: "image_generation_call", result: PNG_B64, revised_prompt: "a rewritten prompt" };

let backendMode = "item";
const backendRequests = [];
const backend = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    backendRequests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
    if (backendMode === "unauthorized" || (backendMode === "refresh-then-ok" && backendRequests.length === 1)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "token expired" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (backendMode === "failed") {
      res.end(sse([{ type: "response.failed", response: { error: { message: "image generation is disabled" } } }]));
      return;
    }
    if (backendMode === "empty") {
      res.end(sse([{ type: "response.completed", response: { output: [{ type: "message", content: [] }] } }]));
      return;
    }
    if (backendMode === "completed-only") {
      res.end(sse([{ type: "response.completed", response: { output: [imageItem] } }]));
      return;
    }
    res.end(sse([{ type: "response.created" }, { type: "response.output_item.done", item: imageItem }, { type: "response.completed", response: { output: [imageItem] } }]));
  });
});
await new Promise((r) => backend.listen(0, "127.0.0.1", r));

const tokenRequests = [];
const tokenServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    tokenRequests.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: fakeJwt(7200) }));
  });
});
await new Promise((r) => tokenServer.listen(0, "127.0.0.1", r));

process.env.CODEX_HOME = codexHome;
process.env.PI_TEXT2IMAGE_PROVIDER = "codex";
process.env.PI_TEXT2IMAGE_CODEX_MODE = "api";
process.env.PI_TEXT2IMAGE_CODEX_BASE_URL = `http://127.0.0.1:${backend.address().port}`;
process.env.PI_TEXT2IMAGE_CODEX_TOKEN_URL = `http://127.0.0.1:${tokenServer.address().port}`;
process.env.PI_TEXT2IMAGE_CODEX_API_MODEL = "gpt-5.6";

const loader = await createLoader();
const { loadConfig, describeConfig, describeBackend } = await loader.import("src/config.ts");
const { generateImages } = await loader.import("src/images.ts");

writeAuth({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { access_token: fakeJwt(3600), id_token: fakeJwt(3600, { aud: "app_from_id_token" }), account_id: "acct-42", refresh_token: "rt.fake" },
});
const config = loadConfig(cwd);
assert.equal(config.codexClientId, undefined, "the client id is not hardcoded in the config");
assert.equal(config.codexMode, "api");
assert.equal(config.timeoutMs, 300_000);
assert.match(describeConfig(config, cwd).join("\n"), /provider {3}codex\/api/);
const backendDescription = describeBackend(config);
assert.equal(backendDescription.label, "codex/api");
assert.equal(backendDescription.model, "gpt-5.6");
assert.match(backendDescription.endpoint, /POST http:\/\/127\.0\.0\.1:\d+\/responses \(tool: image_generation\)/);
console.log("✓ api mode config and backend description");

let images = await generateImages({ config, prompt: "a red panda drinking tea", n: 1, size: "1024x1024" });
assert.equal(images.length, 1);
assert.equal(images[0].mimeType, "image/png");
assert.equal(images[0].revisedPrompt, "a rewritten prompt");
assert.ok(images[0].data.equals(Buffer.from(PNG_B64, "base64")));

const sent = backendRequests.at(-1);
assert.equal(sent.url, "/responses");
assert.equal(sent.headers.authorization, `Bearer ${JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8")).tokens.access_token}`);
assert.equal(sent.headers["chatgpt-account-id"], "acct-42");
assert.equal(sent.headers.originator, "codex_cli_rs");
assert.ok(sent.headers.session_id, "a session id is expected by the backend");
assert.equal(sent.headers.accept, "text/event-stream");
assert.equal(sent.body.model, "gpt-5.6");
assert.equal(sent.body.stream, true);
assert.equal(sent.body.store, false);
assert.deepEqual(sent.body.tools, [{ type: "image_generation", size: "1024x1024" }]);
assert.match(JSON.stringify(sent.body.input), /a red panda drinking tea/);
console.log("✓ responses request: headers, tool spec, prompt");

backendMode = "completed-only";
images = await generateImages({ config, prompt: "x", n: 1 });
assert.equal(images.length, 1, "the image may only appear in response.completed");
console.log("✓ image collected from response.completed too");

// n > 1 issues one call per image
backendMode = "item";
const before = backendRequests.length;
images = await generateImages({ config, prompt: "x", n: 2 });
assert.equal(images.length, 2);
assert.equal(backendRequests.length - before, 2);
console.log("✓ n images means n calls");

// 401 → refresh → retry
backendMode = "refresh-then-ok";
backendRequests.length = 0;
tokenRequests.length = 0;
images = await generateImages({ config, prompt: "x", n: 1 });
assert.equal(images.length, 1);
assert.equal(tokenRequests.length, 1);
assert.deepEqual(Object.keys(tokenRequests[0]).sort(), ["client_id", "grant_type", "refresh_token"], "exactly the fields upstream sends, no scope");
assert.equal(tokenRequests[0].grant_type, "refresh_token");
assert.equal(tokenRequests[0].refresh_token, "rt.fake");
assert.equal(tokenRequests[0].client_id, "app_from_id_token", "the client id comes from the id_token audience");
assert.equal(backendRequests.length, 2, "one rejected call, one retry");
assert.notEqual(backendRequests[1].headers.authorization, backendRequests[0].headers.authorization, "the retry must use the refreshed token");
console.log("✓ 401 triggers a refresh and one retry");

// Where the client id comes from: config → id_token audience → the known Codex id
{
  const { resolveClientId, readCodexTokens } = await loader.import("src/image/provider/codex-api.ts");
  assert.equal(resolveClientId(config, readCodexTokens()), "app_from_id_token");
  assert.equal(resolveClientId({ ...config, codexClientId: "app_explicit" }, readCodexTokens()), "app_explicit");
  // Codex's own override env var, honoured under its real name
  process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID = "app_from_codex_env";
  assert.equal(resolveClientId(config, readCodexTokens()), "app_from_codex_env");
  assert.equal(resolveClientId({ ...config, codexClientId: "app_explicit" }, readCodexTokens()), "app_explicit", "our config still wins");
  delete process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID;
  writeAuth({ auth_mode: "chatgpt", tokens: { access_token: fakeJwt(3600), account_id: "acct-42", refresh_token: "rt.fake" } });
  assert.equal(resolveClientId(config, readCodexTokens()), "app_EMoamEEZ73f0CkXaXp7hrann", "falls back only when there is no id_token");
  console.log("✓ oauth client id: config → CODEX_APP_SERVER_LOGIN_CLIENT_ID → id_token aud → fallback");

  // Codex's refresh-endpoint override is honoured too
  const tokenUrl = process.env.PI_TEXT2IMAGE_CODEX_TOKEN_URL;
  delete process.env.PI_TEXT2IMAGE_CODEX_TOKEN_URL;
  process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = "https://auth.example.test/oauth/token";
  assert.equal(loadConfig(cwd).codexTokenUrl, "https://auth.example.test/oauth/token");
  delete process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
  assert.equal(loadConfig(cwd).codexTokenUrl, "https://auth.openai.com/oauth/token", "upstream default when nothing overrides it");
  process.env.PI_TEXT2IMAGE_CODEX_TOKEN_URL = tokenUrl;
  console.log("✓ CODEX_REFRESH_TOKEN_URL_OVERRIDE is honoured");
}

// An already-expired token refreshes before the first call
writeAuth({ auth_mode: "chatgpt", tokens: { access_token: fakeJwt(-10), id_token: fakeJwt(3600, { aud: "app_from_id_token" }), account_id: "acct-42", refresh_token: "rt.expired" } });
backendMode = "item";
tokenRequests.length = 0;
await generateImages({ config: loadConfig(cwd), prompt: "x", n: 1 });
assert.equal(tokenRequests.at(-1)?.refresh_token, "rt.expired", "an expired token is refreshed up front");
console.log("✓ expired tokens refresh before the call");

// Failures
writeAuth({ auth_mode: "chatgpt", tokens: { access_token: fakeJwt(3600), account_id: "acct-42", refresh_token: "rt.fake" } });
backendMode = "failed";
await assert.rejects(() => generateImages({ config, prompt: "x", n: 1 }), /image generation is disabled/);
backendMode = "empty";
await assert.rejects(() => generateImages({ config, prompt: "x", n: 1 }), /returned no image[\s\S]*codexApiModel/);
backendMode = "unauthorized";
await assert.rejects(() => generateImages({ config: { ...config, codexRefresh: false }, prompt: "x", n: 1 }), /401[\s\S]*codex login/);
console.log("✓ backend failures are reported with the cause");

writeAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-key", tokens: null });
await assert.rejects(() => generateImages({ config, prompt: "x", n: 1 }), /API key rather than ChatGPT tokens[\s\S]*provider "openai"/);
fs.rmSync(path.join(codexHome, "auth.json"));
await assert.rejects(() => generateImages({ config, prompt: "x", n: 1 }), /cannot read[\s\S]*codex login/);
console.log("✓ missing or wrong-shaped auth.json is explained");

backend.close();
tokenServer.close();
for (const dir of [codexHome, cwd]) fs.rmSync(dir, { recursive: true, force: true });
for (const key of ["CODEX_HOME", "PI_TEXT2IMAGE_PROVIDER", "PI_TEXT2IMAGE_CODEX_MODE", "PI_TEXT2IMAGE_CODEX_BASE_URL", "PI_TEXT2IMAGE_CODEX_TOKEN_URL", "PI_TEXT2IMAGE_CODEX_API_MODEL"]) delete process.env[key];
console.log("codex-api.test.mjs passed\n");
