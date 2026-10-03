import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HllStore } from "../src/db.js";
import { startServer } from "../src/server.js";

const directory = mkdtempSync(join(tmpdir(), "hll-tests-"));
const dbPath = join(directory, "test.sqlite");
const store = new HllStore(dbPath);

after(() => {
  try { store.close(); } catch { /* 某些测试会重新打开同一存储并关闭 */ }
});

test("SQLite 持久化：重复加入不改变更新状态，重启后可继续加入", () => {
  store.createCounter("persist", 6);
  const first = store.addKeys("persist", ["", "alpha", "alpha"]);
  const before = store.getCounter("persist");
  assert.equal(first.changed, 2);
  const repeat = store.addKeys("persist", ["alpha", ""]);
  assert.equal(repeat.changed, 0);
  assert.deepEqual(store.getCounter("persist").registers, before.registers);

  store.close();
  const reopened = new HllStore(dbPath);
  const continued = reopened.addKeys("persist", ["beta"]);
  assert.equal(continued.changed, 1);
  assert.equal(continued.totalKeys, 1);
  assert.notDeepEqual(reopened.getCounter("persist").registers, before.registers);
  reopened.close();
});

test("SQLite 合并不兼容精度会被拒绝，兼容快照保留来源", () => {
  const fresh = new HllStore(join(directory, "merge.sqlite"));
  fresh.createCounter("p4", 4);
  fresh.createCounter("p5", 5);
  fresh.addKeys("p4", ["a", "b"]);
  fresh.addKeys("p5", ["a", "c"]);
  assert.throws(() => fresh.mergeToSnapshot("bad", ["p4", "p5"]), /精度、哈希和规则版本/);
  fresh.createCounter("p4b", 4);
  fresh.addKeys("p4b", ["c", "d"]);
  const snapshot = fresh.mergeToSnapshot("ok", ["p4", "p4b"]);
  assert.deepEqual(snapshot.sources, ["p4", "p4b"]);
  assert.equal(fresh.getSnapshot("ok").name, "ok");
  fresh.close();
});

test("导出再导入保留计数器和合并快照", () => {
  const exportedPath = join(directory, "export.json");
  const source = new HllStore(join(directory, "export-source.sqlite"));
  source.createCounter("one", 4);
  source.createCounter("two", 4);
  source.addKeys("one", ["x"]);
  source.addKeys("two", ["y"]);
  source.mergeToSnapshot("snap", ["one", "two"]);
  const bundle = source.exportState();
  assert.equal(bundle.counters.length, 2);
  assert.equal(bundle.snapshots.length, 1);
  const target = new HllStore(join(directory, "export-target.sqlite"));
  const result = target.importState(bundle);
  assert.deepEqual(result, { counters: 2, snapshots: 1 });
  assert.equal(target.getSnapshot("snap").sources.join(","), "one,two");
  target.close();
  source.close();
});

test("HTTP API 创建、加入、估计、合并全链路可用", async () => {
  const running = await startServer({ dbPath: join(directory, "api.sqlite") });
  try {
    const base = `http://127.0.0.1:${running.port}`;
    let response = await fetch(`${base}/counters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "api-a", precision: 6 }),
    });
    assert.equal(response.status, 200);
    await fetch(`${base}/counters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "api-b", precision: 6 }),
    });
    await fetch(`${base}/counters/api-a/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["a", "b", "a", ""]),
    });
    await fetch(`${base}/counters/api-b/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["b", "c"]),
    });
    response = await fetch(`${base}/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "api-merge", sources: ["api-a", "api-b"] }),
    });
    assert.equal(response.status, 200);
    const estimateResponse = await fetch(`${base}/counters/api-a/estimate`);
    const estimateBody = await estimateResponse.json() as { estimatedCardinality: number };
    assert.ok(estimateBody.estimatedCardinality > 0);
  } finally {
    running.close();
  }
});

test("HTTP API 返回明确错误码", async () => {
  const running = await startServer({ dbPath: join(directory, "errors.sqlite") });
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/counters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", precision: 3 }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "INVALID_PRECISION");
  } finally {
    running.close();
  }
});
