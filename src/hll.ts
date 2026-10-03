// 基础 HyperLogLog 实现（无第三方 HLL 库）。
// 规则版本：HLL-V1-SHA256-64

export const RULE_VERSION = 'HLL-V1-SHA256-64';
export const MIN_P = 4;
export const MAX_P = 12;
export const HASH_BITS = 64;

export class HllError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HllError';
  }
}

export type Hasher64 = (key: string) => bigint;

const FNV_MASK = (1n << 64n) - 1n;

// 供测试注入的确定性 64 位“哈希”：FNV-1a(UTF-8)，与键一一对应、分布稳定，
// 仅用于在测试中核对分桶与零计数逻辑；正式路径使用 SHA-256 前 64 位。
export const fnv1a64ForTest: Hasher64 = (key: string) => {
  const bytes = Buffer.from(key, 'utf8');
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & FNV_MASK;
  }
  return hash;
};

import { createHash } from 'node:crypto';

// 对 UTF-8 原始字符串计算 SHA-256，取前 8 个字节（前 64 位），
// 按大端序（高位在前）解释为无符号 64 位整数。
export const sha256First64: Hasher64 = (key: string) => {
  const digest = createHash('sha256').update(Buffer.from(key, 'utf8')).digest();
  return digest.readBigUInt64BE(0);
};

export function alphaFor(m: number): number {
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

export interface EstimateResult {
  rawEstimate: number; // E = alpha*m^2 / sum(2^-R)
  correctedEstimate: number; // 小基数线性计数校正后的结果
  zeroRegisters: number; // 零寄存器数量 V
  precision: number;
  registerCount: number;
  theoreticalRse: number; // 理论相对标准误差 1.04/sqrt(m)
  rseNote: string;
}

export class HyperLogLog {
  readonly p: number;
  readonly m: number;
  readonly registers: Uint8Array;
  readonly ruleVersion: string;
  readonly hashName: string;
  private readonly hasher: Hasher64;

  constructor(
    p: number,
    hasher: Hasher64 = sha256First64,
    hashName = 'sha256-first64',
    registers?: Uint8Array,
    ruleVersion: string = RULE_VERSION,
  ) {
    if (!Number.isInteger(p) || p < MIN_P || p > MAX_P) {
      throw new HllError('INVALID_PRECISION', `精度 p 必须是 ${MIN_P} 至 ${MAX_P} 的整数，收到 ${String(p)}`);
    }
    this.p = p;
    this.m = 2 ** p;
    this.hasher = hasher;
    this.hashName = hashName;
    this.ruleVersion = ruleVersion;
    if (registers !== undefined) {
      validateRegisters(registers, this.m);
      this.registers = Uint8Array.from(registers);
    } else {
      this.registers = new Uint8Array(this.m);
    }
  }

  // 返回寄存器编号与秩（1..w+1），便于测试核对。
  bucketAndRank(key: string): { bucket: number; rank: number } {
    const hash = this.hasher(key);
    return bucketAndRankFromHash(hash, this.p);
  }

  add(key: string): { bucket: number; rank: number; changed: boolean } {
    const { bucket, rank } = this.bucketAndRank(key);
    const previous = this.registers[bucket];
    const changed = rank > previous;
    if (changed) this.registers[bucket] = rank; // 只保留最大秩
    return { bucket, rank, changed };
  }

  addMany(keys: Iterable<string>): { processed: number; changedBuckets: number } {
    let processed = 0;
    let changedBuckets = 0;
    for (const key of keys) {
      processed += 1;
      if (this.add(key).changed) changedBuckets += 1;
    }
    return { processed, changedBuckets };
  }

  estimate(): EstimateResult {
    const { m } = this;
    let sum = 0;
    let zeros = 0;
    for (const rank of this.registers) {
      sum += 2 ** -rank;
      if (rank === 0) zeros += 1;
    }
    const alpha = alphaFor(m);
    const raw = (alpha * m * m) / sum;
    let corrected = raw;
    // 空计数器时所有寄存器均为零，调和平均数无意义，直接给出 0；
    // 非空且小基数、存在零寄存器时使用线性计数校正。
    if (zeros === m) {
      corrected = 0;
    } else if (raw <= 2.5 * m && zeros > 0) {
      corrected = m * Math.log(m / zeros);
    }
    const rse = 1.04 / Math.sqrt(m);
    return {
      rawEstimate: raw,
      correctedEstimate: corrected,
      zeroRegisters: zeros,
      precision: this.p,
      registerCount: m,
      theoreticalRse: rse,
      rseNote:
        '理论相对标准误差约 1.04/sqrt(m)，是大量独立估计的统计标准差参考，' +
        '不是单次估计必然满足的误差界。',
    };
  }

  toSnapshot(): { p: number; ruleVersion: string; hashName: string; registers: string } {
    return {
      p: this.p,
      ruleVersion: this.ruleVersion,
      hashName: this.hashName,
      registers: Buffer.from(this.registers).toString('base64'),
    };
  }
}

// 分桶与计秩的位序规则：
// 64 位哈希视为大端无符号整数；最高 p 位为寄存器编号；
// 剩余 w=64-p 位从最高位起数连续零的个数并加一；全零尾部秩为 w+1。
export function bucketAndRankFromHash(
  hash: bigint,
  p: number,
): { bucket: number; rank: number } {
  if (hash < 0n || hash >= 1n << BigInt(HASH_BITS)) {
    throw new HllError('INVALID_HASH', '注入的哈希必须是 64 位无符号整数');
  }
  if (!Number.isInteger(p) || p < MIN_P || p > MAX_P) {
    throw new HllError('INVALID_PRECISION', `精度 p 必须是 ${MIN_P} 至 ${MAX_P} 的整数`);
  }
  const w = HASH_BITS - p;
  const tailMask = (1n << BigInt(w)) - 1n;
  const tail = hash & tailMask;
  const bucket = Number(hash >> BigInt(w));
  let leadingZeros = 0;
  for (let bit = w - 1; bit >= 0; bit--) {
    if (((tail >> BigInt(bit)) & 1n) === 1n) break;
    leadingZeros += 1;
  }
  return { bucket, rank: leadingZeros + 1 };
}

export function validateRegisters(registers: Uint8Array, m: number): void {
  if (registers.length !== m) {
    throw new HllError(
      'INVALID_REGISTER_LENGTH',
      `寄存器长度必须为 ${m}（p=${String(Math.log2(m))}），收到 ${registers.length}`,
    );
  }
  const maxRank = HASH_BITS - Math.log2(m) + 1;
  for (let i = 0; i < registers.length; i++) {
    const value = registers[i];
    if (value < 0 || value > maxRank) {
      throw new HllError(
        'INVALID_RANK',
        `寄存器[${i}] 秩 ${value} 超出允许范围 0..${maxRank}`,
      );
    }
  }
}

export interface CompatInfo {
  p: number;
  ruleVersion: string;
  hashName: string;
}

export function assertCompatible(a: CompatInfo, b: CompatInfo): void {
  if (a.p !== b.p) {
    throw new HllError('INCOMPATIBLE_PRECISION', `精度不一致：${a.p} 与 ${b.p}，不能合并`);
  }
  if (a.ruleVersion !== b.ruleVersion) {
    throw new HllError(
      'INCOMPATIBLE_RULE_VERSION',
      `规则版本不一致：${a.ruleVersion} 与 ${b.ruleVersion}，不能合并`,
    );
  }
  if (a.hashName !== b.hashName) {
    throw new HllError('INCOMPATIBLE_HASH', `哈希函数不一致：${a.hashName} 与 ${b.hashName}，不能合并`);
  }
}

// 合并：逐位置取最大值，绝不相加两个估计。返回新数组。
export function mergeRegisters(parts: Array<{ info: CompatInfo; registers: Uint8Array }>): {
  p: number;
  ruleVersion: string;
  hashName: string;
  registers: Uint8Array;
} {
  if (parts.length === 0) {
    throw new HllError('EMPTY_MERGE', '合并至少需要一个计数器');
  }
  const first = parts[0];
  const m = 2 ** first.info.p;
  const out = new Uint8Array(m);
  for (const part of parts) {
    assertCompatible(first.info, part.info);
    validateRegisters(part.registers, m);
    for (let i = 0; i < m; i++) {
      if (part.registers[i] > out[i]) out[i] = part.registers[i];
    }
  }
  return {
    p: first.info.p,
    ruleVersion: first.info.ruleVersion,
    hashName: first.info.hashName,
    registers: out,
  };
}

export function decodeRegisters(base64: string, p: number): Uint8Array {
  let raw: Buffer;
  try {
    raw = Buffer.from(base64, 'base64');
  } catch {
    throw new HllError('CORRUPT_STATE', '寄存器数据不是合法的 base64');
  }
  const registers = Uint8Array.from(raw);
  validateRegisters(registers, 2 ** p);
  return registers;
}
