import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HyperLogLog,
  bucketAndRankFromHash,
  mergeRegisters,
  validateRegisters,
  HllError,
  RULE_VERSION,
  sha256First64,
} from '../src/hll';

const info = (p: number) => ({ p, ruleVersion: RULE_VERSION, hashName: 'test-hash' });

test('分桶：前 p 位决定寄存器编号', () => {
  // p=4，高 4 位为 0b1010 = 10
  const { bucket } = bucketAndRankFromHash(0b1010n << 60n, 4);
  assert.equal(bucket, 10);
  // p=12，高 12 位为 0xABC
  const { bucket: bucket12 } = bucketAndRankFromHash(0xABn << 56n | 0xCn << 52n, 12);
  assert.equal(bucket12, 0xabc);
});

test('计秩：剩余位从最高位起数连续零并加一', () => {
  // 桶位为 0，尾部 60 位中偏移 58 处为 1（更高的偏移 59 为 0），前导零 1 个 => 秩 2
  const { bucket, rank } = bucketAndRankFromHash(1n << 58n, 4);
  assert.equal(bucket, 0);
  assert.equal(rank, 2);
  // 偏移 59 处为 1：前导零 0 个 => 秩 1
  assert.equal(bucketAndRankFromHash(1n << 59n, 4).rank, 1);
});

test('计秩：全零尾部采用剩余位数 w 加一', () => {
  const r4 = bucketAndRankFromHash(0n, 4);
  assert.equal(r4.rank, 61); // w=60
  const r12 = bucketAndRankFromHash(0n, 12);
  assert.equal(r12.rank, 53); // w=52
});

test('空计数器：全零寄存器、线性校正估计为 0', () => {
  const hll = new HyperLogLog(6, () => 0n, 'test-hash');
  const estimate = hll.estimate();
  assert.equal(estimate.zeroRegisters, 64);
  assert.ok(estimate.rawEstimate > 0); // 原始调和平均公式对全零寄存器无意义
  assert.equal(estimate.correctedEstimate, 0);
});

test('全重复输入：重复加入同一键不改变状态', () => {
  const hll = new HyperLogLog(8, sha256First64);
  hll.addMany(['dup', 'dup', 'dup']);
  const before = Buffer.from(hll.registers).toString('base64');
  const result = hll.add('dup');
  assert.equal(result.changed, false);
  assert.equal(Buffer.from(hll.registers).toString('base64'), before);
  assert.equal(hll.estimate().zeroRegisters, hll.m - 1);
});

test('秩覆盖：同桶只保留最大秩', () => {
  let counter = 0;
  // 构造同桶（桶 0）但不同秩的两个哈希
  const hasher = (_key: string): bigint => {
    counter += 1;
    if (counter === 1) return 1n << 10n; // 前导零 49 => 秩 50
    return 1n << 20n; // 前导零 39 => 秩 40
    return 1n << 20n;
  };
  const hll = new HyperLogLog(4, hasher, 'test-hash');
  hll.add('a');
  assert.equal(hll.registers[0], 50);
  hll.add('b'); // 秩更小，不能覆盖
  assert.equal(hll.registers[0], 50);
});

test('全零尾部哈希：秩为 w+1 并可正常保存', () => {
  const hll = new HyperLogLog(4, () => 0n, 'test-hash');
  const { rank, changed } = hll.add('anything');
  assert.equal(rank, 61);
  assert.equal(changed, true);
  assert.equal(hll.registers[0], 61);
  validateRegisters(hll.registers, hll.m);
});

test('空字符串是有效键，大小写与空白不归一', () => {
  const hll = new HyperLogLog(10, sha256First64);
  hll.addMany(['', '', 'K', 'k', ' K', 'K ']);
  const estimate = hll.estimate();
  // 5 个不同键；小基数线性校正应接近 5
  assert.ok(estimate.correctedEstimate >= 4 && estimate.correctedEstimate <= 6);
});

test('alpha 常数与大 m 公式', () => {
  const hll16 = new HyperLogLog(4, () => 0n, 'test-hash');
  const sum = hll16.estimate();
  // 全零寄存器：2^-0 = 1，原始 E = 0.673 * 16 = 10.768（空计数器的校正结果为 0）
  assert.ok(Math.abs(sum.rawEstimate - 0.673 * 16) < 1e-9);
  assert.equal(sum.correctedEstimate, 0);
  const big = new HyperLogLog(12, () => 0n, 'test-hash').estimate();
  const expectedAlpha = 0.7213 / (1 + 1.079 / 4096);
  assert.ok(Math.abs(big.rawEstimate - expectedAlpha * 4096) < 1e-9);
});

test('非法精度被拒绝', () => {
  assert.throws(() => new HyperLogLog(3, () => 0n, 't'), (err: Error) => err instanceof HllError);
  assert.throws(() => new HyperLogLog(13, () => 0n, 't'), (err: Error) => err instanceof HllError);
});

test('非法寄存器长度与越界秩被拒绝', () => {
  assert.throws(
    () => new HyperLogLog(4, () => 0n, 't', new Uint8Array(15)),
    (err: Error) => err.message.includes('长度'),
  );
  const bad = new Uint8Array(16);
  bad[3] = 62; // p=4 最大秩 61
  assert.throws(
    () => new HyperLogLog(4, () => 0n, 't', bad),
    (err: Error) => err.message.includes('超出允许范围'),
  );
});

function makeHll(p: number, keys: Array<[string, bigint]>): HyperLogLog {
  const map = new Map(keys);
  const hll = new HyperLogLog(p, (key) => map.get(key) ?? 0n, 'test-hash');
  hll.addMany([...map.keys()]);
  return hll;
}

test('合并：交换、结合、幂等', () => {
  const p = 6;
  // p=6，尾部 w=58；1<<51 落在桶 0（前导零 6，秩 7），1<<44 也在桶 0（秩 14）
  const a = makeHll(p, [['a1', 1n << 51n], ['a2', 1n << 58n]]);
  const b = makeHll(p, [['b1', 1n << 59n], ['a1', 1n << 44n]]);
  const c = makeHll(p, [['c1', 3n << 58n]]);
  const mk = (hll: HyperLogLog) => ({ info: info(p), registers: hll.registers });

  const ab = mergeRegisters([mk(a), mk(b)]).registers;
  const ba = mergeRegisters([mk(b), mk(a)]).registers;
  assert.deepEqual(Array.from(ab), Array.from(ba)); // 交换

  const abThenC = mergeRegisters([{ info: info(p), registers: ab }, mk(c)]).registers;
  const aThenBc = mergeRegisters([mk(a), { info: info(p), registers: mergeRegisters([mk(b), mk(c)]).registers }]).registers;
  assert.deepEqual(Array.from(abThenC), Array.from(aThenBc)); // 结合

  const abab = mergeRegisters([{ info: info(p), registers: ab }, { info: info(p), registers: ba }]).registers;
  assert.deepEqual(Array.from(ab), Array.from(abab)); // 幂等

  // 同桶取最大秩（a1 在 a 中秩 7，在 b 中秩 14）
  assert.equal(ab[0], 14);
});

test('先合并再加入 == 对同一键集合直接计算', () => {
  const p = 8;
  const groupA = ['k1', 'k2', 'shared'];
  const groupB = ['k3', 'shared'];
  const left = new HyperLogLog(p, sha256First64);
  const right = new HyperLogLog(p, sha256First64);
  left.addMany(groupA);
  right.addMany(groupB);
  const merged = mergeRegisters([
    { info: info(p), registers: left.registers },
    { info: info(p), registers: right.registers },
  ]);
  const direct = new HyperLogLog(p, sha256First64);
  direct.addMany([...groupA, ...groupB]);
  assert.deepEqual(Array.from(merged.registers), Array.from(direct.registers));
});

test('兼容性拒绝：精度、哈希、规则版本不一致均拒绝合并', () => {
  const a = makeHll(4, [['a', 1n]]);
  const b = makeHll(5, [['b', 1n]]);
  assert.throws(
    () => mergeRegisters([{ info: info(4), registers: a.registers }, { info: info(5), registers: b.registers }]),
    (err: Error) => err.message.includes('精度'),
  );
  assert.throws(
    () =>
      mergeRegisters([
        { info: info(4), registers: a.registers },
        { info: { p: 4, ruleVersion: 'OTHER', hashName: 'test-hash' }, registers: new Uint8Array(16) },
      ]),
    (err: Error) => err.message.includes('规则版本'),
  );
  assert.throws(
    () =>
      mergeRegisters([
        { info: info(4), registers: a.registers },
        { info: { p: 4, ruleVersion: RULE_VERSION, hashName: 'other-hash' }, registers: new Uint8Array(16) },
      ]),
    (err: Error) => err.message.includes('哈希'),
  );
});

test('SHA-256 前 64 位稳定且不同键不同', () => {
  assert.equal(sha256First64('abc'), sha256First64('abc'));
  assert.notEqual(sha256First64('abc'), sha256First64('abd'));
  assert.equal(typeof sha256First64(''), 'bigint');
});

test('小数据与精确集合对照：估计接近精确值', () => {
  const keys = Array.from({ length: 200 }, (_, i) => `user-${i}`);
  const exact = new Set(keys).size;
  const hll = new HyperLogLog(10, sha256First64);
  hll.addMany(keys);
  const estimate = hll.estimate().correctedEstimate;
  const relativeError = Math.abs(estimate - exact) / exact;
  assert.ok(relativeError < 0.2, `估计 ${estimate} 与精确 ${exact} 偏差过大`);
});
