// Proxy resolution and the CONNECT tunnel, against a local proxy and a local
// TLS server — the tunnel is the part that would otherwise only be exercised in
// production.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { createLoader } from "./pi-runtime.mjs";

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
process.env.CODEX_HOME = codexHome;
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) delete process.env[key];

const loader = await createLoader();
const { parseDotenv, resolveProxySettings, proxyForUrl, bypassesProxy, describeProxy, codexEnvPath } = await loader.import("src/proxy-env.ts");
const { request } = await loader.import("src/http.ts");

// --- resolution ---------------------------------------------------------
assert.deepEqual(parseDotenv('# comment\nexport HTTP_PROXY="http://u:p@h:1"\nNO_PROXY=localhost\nbroken\n'), {
  HTTP_PROXY: "http://u:p@h:1",
  NO_PROXY: "localhost",
});
assert.equal(resolveProxySettings().source, "none");

fs.writeFileSync(codexEnvPath(), 'HTTP_PROXY=http://user:secret@10.0.0.1:3128\nHTTPS_PROXY=http://user:secret@10.0.0.1:3128\nNO_PROXY=localhost,127.0.0.1,.internal\n');
let settings = resolveProxySettings();
assert.equal(settings.source, "codex-env", "the codex .env is the only place the proxy is configured");
assert.equal(proxyForUrl(new URL("https://chatgpt.com/backend-api"), settings).host, "10.0.0.1:3128");
assert.equal(proxyForUrl(new URL("http://127.0.0.1:8080/x"), settings), undefined, "NO_PROXY entry");
assert.equal(proxyForUrl(new URL("https://api.internal/x"), settings), undefined, "NO_PROXY suffix");
assert.ok(bypassesProxy("app.internal", ".internal") && !bypassesProxy("internalish.com", ".internal"));
assert.equal(describeProxy(proxyForUrl(new URL("https://chatgpt.com"), settings)), "http://***@10.0.0.1:3128");
assert.ok(!describeProxy(proxyForUrl(new URL("https://chatgpt.com"), settings)).includes("secret"), "credentials must never be printed");

process.env.HTTP_PROXY = "http://env-proxy:9";
assert.equal(resolveProxySettings().source, "codex-env", "codex .env outranks the process environment");
fs.rmSync(codexEnvPath());
assert.equal(resolveProxySettings().source, "environment");
assert.equal(resolveProxySettings({ httpsProxy: "http://explicit:1" }).source, "config");
delete process.env.HTTP_PROXY;
console.log("✓ proxy resolution: codex .env → environment, NO_PROXY, redaction");

// --- CONNECT tunnel -----------------------------------------------------
const tls = fs.mkdtempSync(path.join(os.tmpdir(), "t2i-tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tls, "key.pem"), "-out", path.join(tls, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });

const target = https.createServer(
  { key: fs.readFileSync(path.join(tls, "key.pem")), cert: fs.readFileSync(path.join(tls, "cert.pem")) },
  (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, via: req.headers["x-test"] ?? null }));
  },
);
await new Promise((r) => target.listen(0, "127.0.0.1", r));

let sawAuth = null;
let sawTarget = null;
const proxy = http.createServer((_req, res) => res.writeHead(400).end());
proxy.on("connect", (req, clientSocket, head) => {
  sawAuth = req.headers["proxy-authorization"] ?? null;
  sawTarget = req.url;
  const [host, port] = req.url.split(":");
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));

const targetPort = target.address().port;
const proxyUrl = new URL(`http://tunneluser:tunnelpass@127.0.0.1:${proxy.address().port}`);
const response = await request(`https://localhost:${targetPort}/hello?x=1`, {
  proxy: proxyUrl,
  rejectUnauthorized: false,
  headers: { "x-test": "through-proxy" },
  timeoutMs: 15_000,
});
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { path: "/hello?x=1", via: "through-proxy" });
assert.equal(sawTarget, `localhost:${targetPort}`);
assert.equal(sawAuth, `Basic ${Buffer.from("tunneluser:tunnelpass").toString("base64")}`, "proxy credentials must be sent");
console.log("✓ https through an authenticated CONNECT proxy");

// A proxy that refuses CONNECT must say so plainly
const refusing = http.createServer((_req, res) => res.writeHead(400).end());
refusing.on("connect", (_req, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
await new Promise((r) => refusing.listen(0, "127.0.0.1", r));
await assert.rejects(
  () => request(`https://localhost:${targetPort}/`, { proxy: new URL(`http://127.0.0.1:${refusing.address().port}`), rejectUnauthorized: false, timeoutMs: 10_000 }),
  /refused CONNECT.*407/,
);
console.log("✓ a refused CONNECT is reported with its status");

for (const server of [target, proxy, refusing]) server.close();
for (const dir of [codexHome, tls]) fs.rmSync(dir, { recursive: true, force: true });
delete process.env.CODEX_HOME;
console.log("proxy.test.mjs passed\n");
