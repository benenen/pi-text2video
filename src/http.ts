// One HTTP path for both providers, with proxy support.
//
// Node's global fetch cannot be pointed at a proxy without pulling in undici's
// ProxyAgent, and this package ships no dependencies — so requests go through
// node:http/node:https here, with CONNECT tunnelling written out for https
// targets and absolute-URI forwarding for plain http ones.

import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import * as tls from "node:tls";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  proxy?: URL;
  /** Tests only: accept self-signed certificates from a local server. */
  rejectUnauthorized?: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  stream: Readable;
  buffer(): Promise<Buffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function proxyAuthHeader(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
}

/** CONNECT through the proxy, then run TLS inside that tunnel. */
function tunnel(proxy: URL, target: URL, rejectUnauthorized: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const port = target.port || "443";
    const connectRequest = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}`, ...proxyAuthHeader(proxy) },
    });
    connectRequest.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy ${proxy.host} refused CONNECT to ${target.hostname}:${port} with ${res.statusCode} ${res.statusMessage ?? ""}`.trim()));
        return;
      }
      resolve(tls.connect({ socket, servername: target.hostname, rejectUnauthorized }));
    });
    connectRequest.once("error", (err) => reject(new Error(`cannot reach proxy ${proxy.host}: ${err.message}`)));
    connectRequest.end();
  });
}

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
  });
}

export async function request(url: string | URL, options: RequestOptions = {}): Promise<HttpResponse> {
  const target = typeof url === "string" ? new URL(url) : url;
  const isHttps = target.protocol === "https:";
  const { proxy, signal, timeoutMs, rejectUnauthorized = true } = options;
  const method = options.method ?? "GET";
  const headers = { ...options.headers };

  // https through a proxy needs a tunnel; plain http is forwarded by absolute URI.
  const socket = proxy && isHttps ? await tunnel(proxy, target, rejectUnauthorized) : undefined;
  const useAbsoluteUri = Boolean(proxy) && !isHttps;
  const requestOptions: https.RequestOptions = {
    method,
    headers: { host: target.host, ...headers, ...(useAbsoluteUri && proxy ? proxyAuthHeader(proxy) : {}) },
    ...(socket
      ? { createConnection: () => socket as unknown as Socket, host: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`, rejectUnauthorized }
      : useAbsoluteUri && proxy
        ? { host: proxy.hostname, port: Number(proxy.port || 80), path: target.toString() }
        : { host: target.hostname, port: target.port || (isHttps ? 443 : 80), path: `${target.pathname}${target.search}`, rejectUnauthorized }),
  };

  return new Promise<HttpResponse>((resolve, reject) => {
    // Checked before the request exists: destroying one whose error listener is
    // not attached yet throws an unhandled ECONNRESET.
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const transport = isHttps ? https : http;
    const req = transport.request(requestOptions);
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(err);
    };
    const timer = timeoutMs ? setTimeout(() => fail(new Error(`request to ${target.host} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs) : undefined;
    const onAbort = () => fail(new Error("cancelled"));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Attached before anything can destroy the request.
    req.once("error", (err) => fail(new Error(`${method} ${target.host}${target.pathname} failed: ${err.message}`)));

    req.once("response", (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const stream = res as unknown as Readable;
      resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? "",
        headers: res.headers,
        stream,
        buffer: () => collect(stream),
        text: async () => (await collect(stream)).toString("utf-8"),
        json: async () => JSON.parse((await collect(stream)).toString("utf-8")),
      });
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Server-sent events as they arrive: yields the payload of each `data:` field. */
export async function* sseEvents(stream: Readable): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf-8");
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data && data !== "[DONE]") yield data;
      separator = buffer.indexOf("\n\n");
    }
  }
}
