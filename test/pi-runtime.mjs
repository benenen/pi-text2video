// The tests run under pi's assumptions: the extension is .ts and the typebox /
// pi-tui imports are provided by pi itself. So this helper does two things:
// locate the pi installation, and borrow its jiti to load .ts directly.
//
// The node_modules symlink exists so jiti (and editors) can resolve typebox and
// @earendil-works/*. The repo installs no dependencies of its own; the symlink
// is gitignored.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findPiRoot() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  let bin;
  try {
    bin = execFileSync("which", ["pi"], { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("pi executable not found; set PI_PACKAGE_DIR to the @earendil-works/pi-coding-agent install directory");
  }
  // .../@earendil-works/pi-coding-agent/dist/bundle/cli.js → package root
  return path.resolve(fs.realpathSync(bin), "..", "..", "..");
}

/**
 * The real ~/.pi/agent/text2image.json would otherwise change what the tests
 * see, so every suite runs against an empty temporary home.
 */
export function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t2i-home-"));
  process.env.HOME = home;
  return home;
}

export async function createLoader() {
  isolateHome();
  const piRoot = findPiRoot();
  const linkTarget = path.join(piRoot, "node_modules");
  const link = path.join(repoRoot, "node_modules");
  if (!fs.existsSync(link)) fs.symlinkSync(linkTarget, link, "dir");

  const { createJiti } = await import(path.join(linkTarget, "jiti", "lib", "jiti.mjs"));
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  return {
    piRoot,
    import: (relative, options) => jiti.import(path.join(repoRoot, relative), options),
  };
}

/** A minimal fake service that branches on the model field of the request body. */
export async function startFakeImagesApi() {
  const http = await import("node:http");
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const pngBuffer = Buffer.from(PNG, "base64");
  const requests = [];

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/file.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(pngBuffer);
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      const send = (code, payload) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const n = parsed.n ?? 1;
      switch (parsed.model) {
        case "url":
          return send(200, { images: [{ url: `http://127.0.0.1:${port}/file.png` }] });
        case "dashscope":
          return send(200, { output: { results: [{ url: `http://127.0.0.1:${port}/file.png` }] } });
        case "unauthorized":
          return send(401, { error: { message: "invalid api key" } });
        case "junk":
          return send(200, { foo: 1 });
        default:
          return send(200, { data: Array.from({ length: n }, () => ({ b64_json: PNG, revised_prompt: "a rewritten prompt" })) });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { port, requests, pngBuffer, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}
