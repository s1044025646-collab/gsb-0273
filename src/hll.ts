import { createHash } from "node:crypto";
import { AppError } from "./errors.js";

export const MIN_P = 4;
export const MAX_P = 12;
export const RULE_VERSION = "HLL-SHA256-64-V1";

export interface HllMetadata {
  precision: number;
  hashAlgorithm: "SHA-256";
  hashBits: 64;
  ruleVersion: typeof RULE_VERSION;
}

export interface EstimateResult {
  estimatedCardinality: number;
  rawEstimate: number;
  correctedEstimate: number;
  zeroRegisters: number;
  registerCount: number;
  precision: number;
  theoreticalRelativeStandardError: number;
  correctionApplied: "smallRange" | "none";
}

export interface HllState extends HllMetadata {
  registers: number[];
}

export function validatePrecision(precision: unknown): asserts precision is number {
  if (typeof precision !== "number" || !Number.isInteger(precision) || precision < MIN_P || precision > MAX_P) {
    throw new AppError(
      "INVALID_PRECISION",
      `精度参数 p 必须是 ${MIN_P} 到 ${MAX_P} 之间的整数。`,
      400,
      { received: precision },
    );
  }
}

export function createRegisters(precision: number): number[] {
  validatePrecision(precision);
  return new Array<number>(2 ** precision).fill(0);
}

export function validateState(state: { precision: unknown; hashAlgorithm: unknown; hashBits: unknown; ruleVersion: unknown; registers: unknown }):
  asserts state is HllState {
  validatePrecision(state.precision);
  const precision: number = state.precision;
  const expectedLength = 2 ** precision;
  if (state.hashAlgorithm !== "SHA-256" || state.hashBits !== 64 || state.ruleVersion !== RULE_VERSION) {
    throw new AppError("INCOMPATIBLE_COUNTERS", "哈希算法、哈希位数或规则版本不受支持。", 422, {
      hashAlgorithm: state.hashAlgorithm,
      hashBits: state.hashBits,
      ruleVersion: state.ruleVersion,
    });
  }
  if (!Array.isArray(state.registers) || state.registers.length !== expectedLength) {
    throw new AppError("INVALID_REGISTERS", "寄存器长度必须等于 2^p。", 422, {
      expectedLength,
      receivedLength: Array.isArray(state.registers) ? state.registers.length : undefined,
    });
  }
  const maxRank = 64 - precision + 1;
  for (const rank of state.registers as unknown[]) {
    if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 0 || rank > maxRank) {
      throw new AppError("INVALID_RANK", `寄存器秩必须是 0 到 ${maxRank} 的整数。`, 422, {
        maxRank,
        received: rank,
      });
    }
  }
}

export function hashKeyTo64Bits(key: string): bigint {
  const digest = createHash("sha256").update(key, "utf8").digest();
  return readBigUint64BE(digest, 0);
}

export function readBigUint64BE(bytes: Uint8Array, offset = 0): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  }
  return value;
}

export function bucketAndRank(hash64: bigint, precision: number): { bucket: number; rank: number } {
  validatePrecision(precision);
  if (hash64 < 0n || hash64 > 0xffffffffffffffffn) {
    throw new AppError("INVALID_STATE", "固定六十四位哈希必须位于 0 到 2^64-1。", 422, { hash64: hash64.toString() });
  }
  const tailBits = 64 - precision;
  const bucketMask = (1n << BigInt(precision)) - 1n;
  const bucket = Number((hash64 >> BigInt(tailBits)) & bucketMask);
  const tail = hash64 & ((1n << BigInt(tailBits)) - 1n);

  if (tail === 0n) {
    return { bucket, rank: tailBits + 1 };
  }

  const highestTailBit = BigInt(tailBits - 1);
  let leadingZeros = 0;
  while (((tail >> (highestTailBit - BigInt(leadingZeros))) & 1n) === 0n) {
    leadingZeros += 1;
  }
  return { bucket, rank: leadingZeros + 1 };
}

export function addHash(registers: number[], precision: number, hash64: bigint): boolean {
  validatePrecision(precision);
  if (registers.length !== 2 ** precision) {
    throw new AppError("INVALID_REGISTERS", "寄存器长度必须等于 2^p。", 422);
  }
  const { bucket, rank } = bucketAndRank(hash64, precision);
  const current = registers[bucket];
  if (current === undefined) {
    throw new AppError("INVALID_REGISTERS", "寄存器桶缺失。", 422);
  }
  if (rank > current) {
    registers[bucket] = rank;
    return true;
  }
  return false;
}

export function addKey(registers: number[], precision: number, key: string): boolean {
  return addHash(registers, precision, hashKeyTo64Bits(key));
}

export function alpha(registerCount: number): number {
  if (registerCount === 16) return 0.673;
  if (registerCount === 32) return 0.697;
 if (registerCount === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / registerCount);
}

export function estimate(registers: number[], precision: number): EstimateResult {
  validatePrecision(precision);
  if (registers.length !== 2 ** precision) {
    throw new AppError("INVALID_REGISTERS", "寄存器长度必须等于 2^p。", 422);
  }
  const registerCount = registers.length;
  let sum = 0;
  let zeroRegisters = 0;
  for (const rank of registers) {
    if (!Number.isInteger(rank) || rank < 0 || rank > 64 - precision + 1) {
      throw new AppError("INVALID_RANK", "检测到超出允许范围的寄存器秩。", 422, { rank });
    }
    sum += 2 ** -rank;
    if (rank === 0) zeroRegisters += 1;
  }
  const rawEstimate = alpha(registerCount) * registerCount * registerCount / sum;
  const correctionApplied = rawEstimate <= 2.5 * registerCount && zeroRegisters > 0;
  const correctedEstimate = correctionApplied
    ? registerCount * Math.log(registerCount / zeroRegisters)
    : rawEstimate;
  return {
    estimatedCardinality: correctedEstimate,
    rawEstimate,
    correctedEstimate,
    zeroRegisters,
    registerCount,
    precision,
    theoreticalRelativeStandardError: 1.04 / Math.sqrt(registerCount),
    correctionApplied: correctionApplied ? "smallRange" : "none",
  };
}

export function requireCompatibleStates(states: HllState[]): void {
  const first = states[0];
  if (!first) throw new AppError("BAD_REQUEST", "至少需要一个计数器。");
  validateState(first);
  for (const state of states.slice(1)) {
    validateState(state);
    if (
      state.precision !== first.precision ||
      state.hashAlgorithm !== first.hashAlgorithm ||
      state.hashBits !== first.hashBits ||
      state.ruleVersion !== first.ruleVersion
    ) {
      throw new AppError("INCOMPATIBLE_COUNTERS", "只能合并精度、哈希和规则版本一致的计数器。", 422);
    }
  }
}

export function mergeStates(states: HllState[]): HllState {
  requireCompatibleStates(states);
  const registers = createRegisters(states[0]!.precision);
  for (const state of states) {
    state.registers.forEach((rank, index) => {
      if (rank > (registers[index] ?? 0)) registers[index] = rank;
    });
  }
  return {
    precision: states[0]!.precision,
    hashAlgorithm: "SHA-256",
    hashBits: 64,
    ruleVersion: RULE_VERSION,
    registers,
  };
}
