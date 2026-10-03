import {
  HyperLogLog,
  HllError,
  RULE_VERSION,
  mergeRegisters,
  sha256First64,
  type EstimateResult,
} from './hll';
import { HllStore, type CounterRow, type SnapshotRow } from './store';

export class HllService {
  constructor(private readonly store: HllStore) {}

  createCounter(name: string, p: number) {
    return this.store.createCounter(name, p);
  }

  listCounters() {
    return this.store.listCounters();
  }

  listSnapshots() {
    return this.store.listSnapshots();
  }

  addKeys(name: string, keys: unknown): {
    name: string;
    processed: number;
    changedBuckets: number;
  } {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
      throw new HllError('INVALID_KEYS', 'keys 必须是字符串数组（空字符串是有效键）');
    }
    const row = this.store.getCounterOrThrow(name);
    const hll = this.loadCounter(row);
    const result = hll.addMany(keys as string[]);
    this.store.replaceRegisters(name, hll.registers);
    return { name, processed: result.processed, changedBuckets: result.changedBuckets };
  }

  getRegisters(name: string): {
    name: string;
    p: number;
    ruleVersion: string;
    hashName: string;
    registers: number[];
    nonZeroRegisters: number;
  } {
    const row = this.store.getCounterOrThrow(name);
    return {
      name: row.name,
      p: row.p,
      ruleVersion: row.ruleVersion,
      hashName: row.hashName,
      registers: Array.from(row.registers),
      nonZeroRegisters: row.registers.reduce((acc, value) => acc + (value > 0 ? 1 : 0), 0),
    };
  }

  estimate(name: string): { name: string } & EstimateResult {
    const row = this.store.getCounterOrThrow(name);
    const estimate = this.loadCounter(row).estimate();
    return { name, ...estimate };
  }

  // 生成合并快照：来源可以是计数器或已有快照；不修改来源，不相加估计。
  mergeIntoSnapshot(input: {
    snapshotName: string;
    sources: Array<{ kind: 'counter' | 'snapshot'; name: string }>;
  }): { snapshotName: string; sources: unknown; estimate: EstimateResult } {
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      throw new HllError('EMPTY_MERGE', '合并至少需要一个来源');
    }
    const parts = input.sources.map((source) => {
      if (source.kind === 'counter') {
        const counter = this.store.getCounter(source.name);
        if (!counter) throw new HllError('NOT_FOUND', `来源计数器 ${source.name} 不存在`);
        return {
          info: { p: counter.p, ruleVersion: counter.ruleVersion, hashName: counter.hashName },
          registers: counter.registers,
        };
      }
      if (source.kind === 'snapshot') {
        const snapshot = this.store.getSnapshot(source.name);
        if (!snapshot) throw new HllError('NOT_FOUND', `来源快照 ${source.name} 不存在`);
        return {
          info: { p: snapshot.p, ruleVersion: snapshot.ruleVersion, hashName: snapshot.hashName },
          registers: snapshot.registers,
        };
      }
      throw new HllError('INVALID_SOURCE_KIND', `未知来源类型 ${String(source.kind)}`);
    });
    const merged = mergeRegisters(parts);
    const saved: SnapshotRow = this.store.saveSnapshot({
      name: input.snapshotName,
      p: merged.p,
      ruleVersion: merged.ruleVersion,
      hashName: merged.hashName,
      registers: merged.registers,
      sources: input.sources,
    });
    const estimate = new HyperLogLog(
      saved.p,
      sha256First64,
      saved.hashName,
      saved.registers,
      saved.ruleVersion,
    ).estimate();
    return { snapshotName: saved.name, sources: JSON.parse(saved.sources), estimate };
  }

  getSnapshot(name: string) {
    const snapshot = this.store.getSnapshotOrThrow(name);
    return {
      name: snapshot.name,
      p: snapshot.p,
      ruleVersion: snapshot.ruleVersion,
      hashName: snapshot.hashName,
      registers: Array.from(snapshot.registers),
      sources: JSON.parse(snapshot.sources),
      createdAt: snapshot.createdAt,
      estimate: new HyperLogLog(
        snapshot.p,
        sha256First64,
        snapshot.hashName,
        snapshot.registers,
        snapshot.ruleVersion,
      ).estimate(),
    };
  }

  exportState() {
    return { ruleVersion: RULE_VERSION, ...this.store.exportAll() };
  }

  importState(data: Parameters<HllStore['importAll']>[0]) {
    return this.store.importAll(data);
  }

  private loadCounter(row: CounterRow): HyperLogLog {
    return new HyperLogLog(
      row.p,
      sha256First64,
      row.hashName,
      row.registers,
      row.ruleVersion,
    );
  }
}
