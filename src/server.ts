import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { HllStore } from "./db.js";
import { estimate } from "./hll.js";
import { AppError } from "./errors.js";

export interface ServeOptions {
  port?: number;
  dbPath?: string;
  host?: string;
}

interface RequestContext {
  store: HllStore;
  url: URL;
  body: unknown;
}

type Handler = (context: RequestContext) => unknown | Promise<unknown>;

export function chooseFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolvePort(port));
      } else {
        server.close(() => reject(new Error("无法获取空闲端口。")));
      }
    });
  });
}

export async function startServer(options: ServeOptions = {}): Promise<{ server: Server; port: number; close: () => void }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? await chooseFreePort(host);
  const store = new HllStore(options.dbPath ?? "data/hll.sqlite");
  const server = createServer((request, response) => {
    void handleRequest(request, response, store).catch((error: unknown) => {
      sendError(response, error);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(port, host, resolveListen));
  const actualPort = (server.address() as { port: number }).port;
  const close = () => {
    server.closeAllConnections?.();
    server.close();
    store.close();
  };
  return { server, port: actualPort, close };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, store: HllStore): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/health") return sendJson(response, 200, { ok: true });
  const body = await readJson(request);
  const route = matchRoute(request.method ?? "GET", url.pathname);
  if (!route) throw new AppError("BAD_REQUEST", "没有匹配的 API 路径。", 404);
  const result = await route({ store, url, body });
  sendJson(response, 200, result);
}

function matchRoute(method: string, pathname: string): Handler | null {
  const routes: Array<{ method: string; pattern: RegExp; handler: (parts: RegExpExecArray, context: RequestContext) => unknown }> = [
    { method: "POST", pattern: /^\/counters$/, handler: (_parts, { store, body }) => createCounter(store, body) },
    { method: "GET", pattern: /^\/counters$/, handler: (_parts, { store }) => store.listCounters() },
    { method: "GET", pattern: /^\/counters\/([^/]+)$/, handler: (parts, { store }) => store.getCounter(decodeURIComponent(parts[1]!)) },
    { method: "POST", pattern: /^\/counters\/([^/]+)\/keys$/, handler: (parts, { store, body }) => store.addKeys(decodeURIComponent(parts[1]!), requireKeys(body)) },
    { method: "GET", pattern: /^\/counters\/([^/]+)\/registers$/, handler: (parts, { store }) => store.getCounter(decodeURIComponent(parts[1]!)) },
    { method: "GET", pattern: /^\/counters\/([^/]+)\/estimate$/, handler: (parts, { store }) => {
      const counter = store.getCounter(decodeURIComponent(parts[1]!));
      return { name: counter.name, ...estimate(counter.registers, counter.precision) };
    } },
    { method: "POST", pattern: /^\/snapshots$/, handler: (_parts, { store, body }) => mergeSnapshot(store, body) },
    { method: "GET", pattern: /^\/snapshots$/, handler: (_parts, { store }) => store.listSnapshots() },
    { method: "GET", pattern: /^\/snapshots\/([^/]+)$/, handler: (parts, { store }) => store.getSnapshot(decodeURIComponent(parts[1]!)) },
    { method: "GET", pattern: /^\/export$/, handler: (_parts, { store }) => store.exportState() },
    { method: "POST", pattern: /^\/import$/, handler: (_parts, { store, body }) => ({ imported: store.importState(body) }) },
  ];
  for (const route of routes) {
    const parts = route.pattern.exec(pathname);
    if (route.method === method && parts) return (context) => route.handler(parts, context);
  }
  return null;
}

function createCounter(store: HllStore, body: unknown) {
  if (typeof body !== "object" || body === null) throw new AppError("BAD_REQUEST", "请求体必须是 JSON 对象。");
  const name = (body as { name?: unknown }).name;
  const precision = (body as { precision?: unknown }).precision;
  if (typeof name !== "string") throw new AppError("INVALID_NAME", "name 必须是字符串。");
  if (!Number.isInteger(precision)) throw new AppError("INVALID_PRECISION", "precision 必须是整数。");
  return store.createCounter(name, precision as number);
}

function requireKeys(body: unknown): string[] {
  if (!Array.isArray(body) || body.some((key) => typeof key !== "string")) {
    throw new AppError("INVALID_KEYS", "请求体必须是字符串数组；空字符串是有效键。");
  }
  return body;
}

function mergeSnapshot(store: HllStore, body: unknown) {
  if (typeof body !== "object" || body === null) throw new AppError("BAD_REQUEST", "请求体必须是 JSON 对象。");
  const name = (body as { name?: unknown }).name;
  const sources = (body as { sources?: unknown }).sources;
  if (typeof name !== "string") throw new AppError("INVALID_NAME", "name 必须是字符串。");
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== "string")) {
    throw new AppError("BAD_REQUEST", "sources 必须是字符串数组。");
  }
  return store.mergeToSnapshot(name, sources);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 10_000_000) throw new AppError("BAD_REQUEST", "请求体不能超过 10MB。", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppError("BAD_REQUEST", "请求体不是合法 JSON。");
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof AppError) {
    sendJson(response, error.statusCode, { error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  const message = error instanceof Error ? error.message : "未知错误。";
  sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message } });
}
