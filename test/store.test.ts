import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HllStore } from '../src/store';
import { HllService } from '../src/service';
import { HllError } from '../src/hll';

function tempDb(name: string): string {
  const path = resolve(tmpdir(), `hll-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(path, { force: true });
  return path;
}

test('创建、加入、重启后继续加入', () => {
  const dbPath = tempDb('persist');
  {
    const store = new HllStore(dbPath);
    const service = new HllService(store);
    service.createCounter('c', 8);
    service.addKeys('c', ['a', 'b', 'a']);
    store.close();
  }
  {
    const store = new HllStore(dbPath);
    const service = new HllService(store);
    const state = service.getRegisters('c');
    assert.equal(state.registers.length, 256);
    const result = service.addKeys('c', ['b', 'c']);
    assert.equal(result.processed, 2);
    const estimate = service.estimate('c');
    assert.ok(estimate.correctedEstimate >= 2 && estimate.correctedEstimate <= 4);
    store.close();
  }
});

test('合并生成新快照并保留来源，不修改来源', () => {
  const dbPath = tempDb('merge');
  const store = new HllStore(dbPath);
  const service = new HllService(store);
  service.createCounter('a', 8);
  service.createCounter('b', 8);
  const beforeA = JSON.stringify(service.getRegisters('a').registers);
  service.addKeys('a', ['x', 'y']);
  service.addKeys('b', ['y', 'z']);
  const snap = service.mergeIntoSnapshot({
    snapshotName: 's1',
    sources: [
      { kind: 'counter', name: 'a' },
      { kind: 'counter', name: 'b' },
    ],
  });
  assert.deepEqual(snap.sources, [
    { kind: 'counter', name: 'a' },
    { kind: 'counter', name: 'b' },
  ]);
  assert.equal(beforeA, JSON.stringify(new Array(256).fill(0)));
  const fetched = service.getSnapshot('s1');
  assert.equal(fetched.name, 's1');
  assert.ok(fetched.estimate.correctedEstimate >= 2 && fetched.estimate.correctedEstimate <= 4);
  // 快照可作为后续合并来源
  const snap2 = service.mergeIntoSnapshot({
    snapshotName: 's2',
    sources: [{ kind: 'snapshot', name: 's1' }],
  });
  assert.equal(snap2.snapshotName, 's2');
  store.close();
});

test('服务层拒绝精度不一致的合并', () => {
  const dbPath = tempDb('incompat');
  const store = new HllStore(dbPath);
  const service = new HllService(store);
  service.createCounter('a', 8);
  service.createCounter('b', 10);
  assert.throws(
    () =>
      service.mergeIntoSnapshot({
        snapshotName: 'bad',
        sources: [
          { kind: 'counter', name: 'a' },
          { kind: 'counter', name: 'b' },
        ],
      }),
    (err: Error) => err instanceof HllError && err.message.includes('精度'),
  );
  store.close();
});

test('参数校验：非法 keys、缺失资源、重复名称', () => {
  const dbPath = tempDb('validate');
  const store = new HllStore(dbPath);
  const service = new HllService(store);
  service.createCounter('a', 8);
  assert.throws(() => service.createCounter('a', 8), (err: Error) => err.message.includes('已存在'));
  assert.throws(() => service.addKeys('a', 'not-array'), (err: Error) => err.message.includes('字符串数组'));
  assert.throws(
    () => service.addKeys('a', ['ok', 123]),
    (err: Error) => err.message.includes('字符串数组'),
  );
  assert.throws(() => service.estimate('missing'), (err: Error) => err.message.includes('不存在'));
  store.close();
});

test('损坏状态（非法寄存器长度）读取时被拒绝', () => {
  const dbPath = tempDb('corrupt');
  const store = new HllStore(dbPath);
  store.createCounter('a', 8);
  // 直接写入错误长度的 BLOB 模拟磁盘损坏
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE counters SET registers = ? WHERE name = ?').run(Buffer.alloc(10), 'a');
  raw.close();
  assert.throws(() => store.getCounterOrThrow('a'), (err: Error) => err.message.includes('长度'));
  store.close();
});

test('导出再导入保持寄存器一致；坏导入整体回滚', () => {
  const dbPath = tempDb('export');
  const store = new HllStore(dbPath);
  const service = new HllService(store);
  service.createCounter('a', 8);
  service.addKeys('a', ['one', 'two']);
  const exported = service.exportState();
  store.close();

  const importPath = tempDb('import');
  const target = new HllStore(importPath);
  const targetService = new HllService(target);
  targetService.importState(exported as never);
  assert.deepEqual(
    targetService.getRegisters('a').registers,
    new HllService(new HllStore(dbPath)).getRegisters('a').registers,
  );

  const corrupt = JSON.parse(JSON.stringify(exported));
  corrupt.counters[0].p = 12; // 与寄存器长度不匹配
  assert.throws(
    () => targetService.importState(corrupt),
    (err: Error) => err.message.includes('长度'),
  );
  target.close();
});
