import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { HllError } from './hll';
import { HllService } from './service';

const HTTP_STATUS: Record<string, number> = {
  INVALID_PRECISION: 400,
  INVALID_NAME: 400,
  INVALID_KEYS: 400,
  INVALID_SOURCE_KIND: 400,
  INVALID_REGISTER_LENGTH: 400,
  INVALID_RANK: 400,
  INVALID_HASH: 400,
  INVALID_JSON: 400,
  INVALID_PORT: 400,
  INVALID_FILE: 400,
  EMPTY_MERGE: 400,
  ALREADY_EXISTS: 409,
  NOT_FOUND: 404,
  INCOMPATIBLE_PRECISION: 409,
  INCOMPATIBLE_RULE_VERSION: 409,
  INCOMPATIBLE_HASH: 409,
  CORRUPT_STATE: 500,
};

export function errorStatus(code: string): number {
  return HTTP_STATUS[code] ?? 400;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  if (body === '') return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HllError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createApp(service: HllService): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathParts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/counters') {
        sendJson(res, 200, { counters: service.listCounters() });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/snapshots') {
        sendJson(res, 200, { snapshots: service.listSnapshots() });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/counters') {
        const body = (await readJson(req)) as { name?: unknown; p?: unknown };
        if (typeof body.name !== 'string' || !Number.isInteger(body.p)) {
          throw new HllError('INVALID_PRECISION', '需要字符串 name 与整数 p（4..12）');
        }
        sendJson(res, 201, service.createCounter(body.name, body.p as number));
        return;
      }

      const counterAction = matchCounterRoute(pathParts, method);
      if (counterAction) {
        const name = decodeURIComponent(pathParts[2]);
        if (counterAction === 'registers') {
          sendJson(res, 200, service.getRegisters(name));
          return;
        }
        if (counterAction === 'estimate') {
          sendJson(res, 200, service.estimate(name));
          return;
        }
        if (counterAction === 'add') {
          const body = (await readJson(req)) as { keys?: unknown };
          sendJson(res, 200, service.addKeys(name, body.keys));
          return;
        }
      }

      if (method === 'POST' && pathParts.length === 2 && pathParts[0] === 'api' && pathParts[1] === 'merge') {
        const body = (await readJson(req)) as { snapshotName?: unknown; sources?: unknown };
        sendJson(res, 201, service.mergeIntoSnapshot(body as never));
        return;
      }
      if (method === 'GET' && pathParts.length === 3 && pathParts[0] === 'api' && pathParts[1] === 'snapshots') {
        sendJson(res, 200, service.getSnapshot(decodeURIComponent(pathParts[2])));
        return;
      }
      if (method === 'GET' && url.pathname === '/api/export') {
        sendJson(res, 200, service.exportState());
        return;
      }
      if (method === 'POST' && url.pathname === '/api/import') {
        const body = await readJson(req);
        sendJson(res, 200, service.importState(body as never));
        return;
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '未知的 API 路径' } });
    } catch (err) {
      if (err instanceof HllError) {
        sendJson(res, errorStatus(err.code), { error: { code: err.code, message: err.message } });
      } else {
        sendJson(res, 500, {
          error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  });
}

function matchCounterRoute(
  pathParts: string[],
  method: string,
): 'registers' | 'estimate' | 'add' | undefined {
  if (pathParts.length !== 4 || pathParts[0] !== 'api' || pathParts[1] !== 'counters') {
    return undefined;
  }
  const action = pathParts[3];
  if (method === 'GET' && action === 'registers') return 'registers';
  if (method === 'GET' && action === 'estimate') return 'estimate';
  if (method === 'POST' && action === 'add') return 'add';
  return undefined;
}

// 探测一个空闲端口（默认行为）。
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('无法获取空闲端口'));
      });
    });
  });
}
