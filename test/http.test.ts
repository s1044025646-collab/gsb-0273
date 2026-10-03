import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { HllStore } from '../src/store';
import { HllService } from '../src/service';
import { createApp, findFreePort, errorStatus } from '../src/http';
import type { Server } from 'node:http';

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('HTTP 全流程与错误码', async () => {
  const dbPath = resolve(tmpdir(), `hll-http-${Date.now()}.db`);
  rmSync(dbPath, { force: true });
  const store = new HllStore(dbPath);
  const service = new HllService(store);
  const server: Server = createApp(service);
  const port = await findFreePort();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    const health = await request(port, 'GET', '/health');
    assert.equal(health.status, 200);

    const created = await request(port, 'POST', '/api/counters', { name: 'c1', p: 8 });
    assert.equal(created.status, 201);

    const badP = await request(port, 'POST', '/api/counters', { name: 'c2', p: 3 });
    assert.equal(badP.status, 400);
    assert.equal(badP.json.error.code, 'INVALID_PRECISION');

    const dup = await request(port, 'POST', '/api/counters', { name: 'c1', p: 8 });
    assert.equal(dup.status, 409);

    const added = await request(port, 'POST', '/api/counters/c1/add', {
      keys: ['a', 'b', 'a', ''],
    });
    assert.equal(added.status, 200);
    assert.equal(added.json.processed, 4);

    const estimate = await request(port, 'GET', '/api/counters/c1/estimate');
    assert.equal(estimate.status, 200);
    assert.equal(estimate.json.precision, 8);
    assert.ok(estimate.json.rseNote.includes('不是单次'));

    const registers = await request(port, 'GET', '/api/counters/c1/registers');
    assert.equal(registers.json.registers.length, 256);

    const merged = await request(port, 'POST', '/api/merge', {
      snapshotName: 's1',
      sources: [{ kind: 'counter', name: 'c1' }],
    });
    assert.equal(merged.status, 201);

    const snapshot = await request(port, 'GET', '/api/snapshots/s1');
    assert.equal(snapshot.json.sources[0].name, 'c1');

    const exported = await request(port, 'GET', '/api/export');
    assert.equal(exported.json.counters.length, 1);

    const missing = await request(port, 'GET', '/api/counters/nope/estimate');
    assert.equal(missing.status, 404);
    assert.equal(errorStatus('NOT_FOUND'), 404);
  } finally {
    server.close();
    store.close();
  }
});

void (0 as unknown as AddressInfo);
