// 演示：固定几组小数据，用独立精确集合（Set）对照 HLL 估计偏差。
// 精确集合只存在于演示验证路径，绝不参与正式计数器的存储或计数。
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { HyperLogLog, sha256First64, fnv1a64ForTest } from './hll';
import { HllStore } from './store';
import { HllService } from './service';

function makeDataset(kind: string): string[] {
  if (kind === 'fruits') {
    return ['apple', 'banana', '', 'APPLE', ' apple', 'banana', 'cherry', 'date'];
  }
  if (kind === 'nums') {
    return Array.from({ length: 50 }, (_, i) => `num-${i}`);
  }
  return Array.from({ length: 500 }, (_, i) => `item-${(i % 300).toString().padStart(4, '0')}`);
}

function report(title: string, keys: string[], p: number): void {
  const exact = new Set(keys);
  const hll = new HyperLogLog(p, sha256First64);
  hll.addMany(keys);
  const estimate = hll.estimate();
  const used = estimate.correctedEstimate;
  const bias = (used - exact.size) / exact.size;
  console.log(
    [
      `[${title}] p=${p}, m=${hll.m}`,
      `输入=${keys.length}`,
      `精确不同键=${exact.size}（独立 Set 对照）`,
      `原始E=${estimate.rawEstimate.toFixed(2)}`,
      `校正估计=${used.toFixed(2)}`,
      `零寄存器V=${estimate.zeroRegisters}`,
      `相对偏差=${(bias * 100).toFixed(1)}%`,
      `理论RSE=${(estimate.theoreticalRse * 100).toFixed(1)}%（非误差界）`,
    ].join(' | '),
  );
}

function main(): void {
  console.log('=== 1. 固定小数据与精确数量对照 ===');
  for (const p of [4, 8, 12]) {
    report('fruits', makeDataset('fruits'), p);
  }
  report('nums-50', makeDataset('nums'), 6);
  report('items-300/500', makeDataset('items'), 10);

  console.log('\n=== 2. 空字符串、大小写与空白不归一 ===');
  const hll = new HyperLogLog(10, sha256First64);
  hll.addMany(['', '', 'A', 'a', ' A', 'A ']);
  console.log(`6 次加入，精确不同键为 5，HLL 估计=${hll.estimate().correctedEstimate.toFixed(2)}`);

  console.log('\n=== 3. 重复加入不改变状态 ===');
  const hll2 = new HyperLogLog(8, sha256First64);
  hll2.addMany(['x', 'y']);
  const before = Buffer.from(hll2.registers).toString('base64');
  hll2.addMany(['x', 'y', 'x']);
  const after = Buffer.from(hll2.registers).toString('base64');
  console.log(`重复加入后寄存器是否变化: ${before === after ? '否' : '是'}`);

  console.log('\n=== 4. 合并：先合并再加入 == 对同一键集合直接计算 ===');
  const p = 10;
  const groupA = ['a1', 'a2', 'a3', 'shared'];
  const groupB = ['b1', 'b2', 'shared'];
  const left = new HyperLogLog(p, sha256First64);
  const right = new HyperLogLog(p, sha256First64);
  left.addMany(groupA);
  right.addMany(groupB);
  const direct = new HyperLogLog(p, sha256First64);
  direct.addMany([...groupA, ...groupB]);
  const { mergeRegisters } = require('./hll') as typeof import('./hll');
  const merged = mergeRegisters([
    { info: { p, ruleVersion: left.ruleVersion, hashName: left.hashName }, registers: left.registers },
    { info: { p, ruleVersion: right.ruleVersion, hashName: right.hashName }, registers: right.registers },
  ]);
  const same = Buffer.compare(Buffer.from(merged.registers), Buffer.from(direct.registers)) === 0;
  console.log(
    `合并寄存器与直接对并集计算完全一致: ${same ? '是' : '否'} | ` +
      `精确并集=${new Set([...groupA, ...groupB]).size} | 估计=${new HyperLogLog(p, sha256First64, merged.hashName, merged.registers).estimate().correctedEstimate.toFixed(2)}`,
  );

  console.log('\n=== 5. SQLite 重启后继续加入 ===');
  const dbPath = resolve(process.cwd(), 'data', 'demo-hll.db');
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  {
    const store = new HllStore(dbPath);
    const service = new HllService(store);
    service.createCounter('visitors', 8);
    service.addKeys('visitors', ['u1', 'u2', 'u3', 'u1']);
    store.close();
  }
  {
    const store = new HllStore(dbPath);
    const service = new HllService(store);
    service.addKeys('visitors', ['u3', 'u4', 'u5']);
    const state = service.estimate('visitors');
    console.log(
      `重启前 3 个不同键，重启后再加入 2 个，精确=5，估计=${state.correctedEstimate.toFixed(2)}`,
    );
    const mergedSnapshot = service.mergeIntoSnapshot({
      snapshotName: 'visitors-snap',
      sources: [{ kind: 'counter', name: 'visitors' }],
    });
    console.log(`生成快照 ${mergedSnapshot.snapshotName}，来源已保留`);
    store.close();
  }

  console.log('\n=== 6. 注入固定 64 位“哈希”核对分桶/计秩（测试路径） ===');
  const injected = new HyperLogLog(4, fnv1a64ForTest, 'fnv1a64-test');
  const hit = injected.bucketAndRank('abc');
  console.log(`fnv1a64("abc") 落入桶 ${hit.bucket}，秩 ${hit.rank}`);
  injected.addMany(['abc', 'abc', 'abd']);
  console.log(`重复键被压缩为寄存器，非零寄存器数=${Array.from(injected.registers).filter((r) => r > 0).length}`);
}

main();
