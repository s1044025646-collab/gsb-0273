import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RULE_VERSION,
  addHash,
  bucketAndRank,
  createRegisters,
  estimate,
  hashKeyTo64Bits,
  mergeStates,
  validateState,
  type HllState,
} from "../src/hll.js";

function state(registers: number[], precision = 4): HllState {
  return { precision, hashAlgorithm: "SHA-256", hashBits: 64, ruleVersion: RULE_VERSION, registers };
}

test("固定 64 位哈希：前 p 位分桶，剩余最高位起计算秩", () => {
  assert.deepEqual(bucketAndRank(0xA100_0000_0000_0000n, 4), { bucket: 0b1010, rank: 4 });
  assert.deepEqual(bucketAndRank((0b1010n << 60n) | (1n << 59n), 4), { bucket: 0b1010, rank: 1 });
});

test("全零尾部的秩是剩余位数加一", () => {
  assert.deepEqual(bucketAndRank(0xA000_0000_0000_0000n, 4), { bucket: 10, rank: 61 });
  assert.deepEqual(bucketAndRank(0n, 12), { bucket: 0, rank: 53 });
});

test("空计数器返回零寄存器数量和小范围校正", () => {
  const result = estimate(createRegisters(4), 4);
  assert.equal(result.zeroRegisters, 16);
  assert.equal(result.rawEstimate > 0, true);
  assert.equal(result.correctedEstimate, 0);
  assert.equal(result.correctionApplied, "smallRange");
  assert.equal(Number(result.theoreticalRelativeStandardError.toFixed(6)), 0.26);
});

test("全重复输入只保留最大秩且重复加入不改变寄存器", () => {
  const registers = createRegisters(4);
  const hash = 0xA100_0000_0000_0000n;
  assert.equal(addHash(registers, 4, hash), true);
  const afterFirst = registers.slice();
  assert.equal(addHash(registers, 4, hash), false);
  assert.deepEqual(registers, afterFirst);
  assert.equal(registers[10], 4);
});

test("较大秩覆盖较小秩，较小秩不能回退", () => {
  const registers = createRegisters(4);
  addHash(registers, 4, 0xA400_0000_0000_0000n);
  addHash(registers, 4, 0xA010_0000_0000_0000n);
  assert.equal(registers[10], 8);
  addHash(registers, 4, 0xA200_0000_0000_0000n);
  assert.equal(registers[10], 8);
});

test("UTF-8 空字符串、大小写和空白不归一", () => {
  assert.notEqual(hashKeyTo64Bits(""), hashKeyTo64Bits(" "));
  assert.notEqual(hashKeyTo64Bits("a"), hashKeyTo64Bits("A"));
  assert.notEqual(hashKeyTo64Bits("a"), hashKeyTo64Bits(" a"));
});

test("拒绝错误长度、非法秩和不兼容元数据", () => {
  assert.throws(() => validateState(state([0, 0])), /寄存器长度/);
  assert.throws(() => validateState(state([...createRegisters(4).fill(0).slice(1), 99])), /寄存器秩/);
  assert.throws(() => mergeStates([state(createRegisters(4), 4), state(createRegisters(5), 5)]), /精度、哈希和规则版本/);
  assert.throws(() => validateState({ ...state(createRegisters(4)), ruleVersion: "OTHER" }), /规则版本/);
});

test("合并满足交换律、结合律和幂等律", () => {
  const a = state(createRegisters(4));
  const b = state(createRegisters(4));
  const c = state(createRegisters(4));
  addHash(a.registers, 4, 0b0001_0000_1000_0000n);
  addHash(b.registers, 4, 0b0001_0000_0100_0000n);
  addHash(c.registers, 4, 0b0010_0000_0010_0000n);
  const ab = mergeStates([a, b]).registers;
  const ba = mergeStates([b, a]).registers;
  const abThenC = mergeStates([state(mergeStates([a, b]).registers), c]).registers;
  const aThenBC = mergeStates([a, state(mergeStates([b, c]).registers)]).registers;
  assert.deepEqual(ab, ba);
  assert.deepEqual(abThenC, aThenBC);
  assert.deepEqual(mergeStates([state(ab), state(ab)]).registers, ab);
  assert.deepEqual(mergeStates([state(abThenC), state(abThenC)]).registers, abThenC);
});

test("先合并再加入等价于对同一键集合直接计算", () => {
  const leftHashes = [1n, 2n, 0x9000_0000_0000_0000n];
  const rightHashes = [3n, 2n, 0x7000_0000_0000_0000n];
  const direct = createRegisters(8);
  for (const hash64 of [...leftHashes, ...rightHashes]) addHash(direct, 8, hash64);
  const left = createRegisters(8);
  const right = createRegisters(8);
  leftHashes.forEach((hash64) => addHash(left, 8, hash64));
  rightHashes.forEach((hash64) => addHash(right, 8, hash64));
  const merged = mergeStates([state(left, 8), state(right, 8)]).registers;
  assert.deepEqual(merged, direct);
});

test("固定小数据集与精确数量对照，但不要求落入理论误差", () => {
  const keys = Array.from({ length: 80 }, (_unused, index) => `key-${index}`);
  const registers = createRegisters(8);
  for (const key of keys) addHash(registers, 8, hashKeyTo64Bits(key));
  const result = estimate(registers, 8);
  const exact = new Set(keys).size;
  assert.equal(exact, 80);
  assert.ok(Number.isFinite(result.estimatedCardinality));
  assert.ok(result.estimatedCardinality > 0);
});
