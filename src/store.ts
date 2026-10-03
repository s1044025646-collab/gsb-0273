import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  HllError,
  MAX_P,
  MIN_P,
  RULE_VERSION,
  decodeRegisters,
  validateRegisters,
} from './hll';

export interface CounterRow {
  id: number;
  name: string;
  p: number;
  ruleVersion: string;
  hashName: string;
  registers: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotRow {
  id: number;
  name: string;
  p: number;
  ruleVersion: string;
  hashName: string;
  registers: Uint8Array;
  sources: string; // JSON 数组，记录来源计数器/快照 id 与名称
  createdAt: string;
}

export class HllStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        p INTEGER NOT NULL,
        rule_version TEXT NOT NULL,
        hash_name TEXT NOT NULL,
        registers BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        p INTEGER NOT NULL,
        rule_version TEXT NOT NULL,
        hash_name TEXT NOT NULL,
        registers BLOB NOT NULL,
        sources TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  createCounter(name: string, p: number, hashName = 'sha256-first64'): Omit<CounterRow, 'registers'> & { registerCount: number } {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new HllError('INVALID_NAME', '计数器名称不能为空');
    }
    if (!Number.isInteger(p) || p < MIN_P || p > MAX_P) {
      throw new HllError('INVALID_PRECISION', `精度 p 必须是 ${MIN_P} 至 ${MAX_P} 的整数，收到 ${String(p)}`);
    }
    const exists = this.db.prepare('SELECT id FROM counters WHERE name = ?').get(name);
    if (exists) throw new HllError('ALREADY_EXISTS', `计数器 ${name} 已存在`);
    const registers = Buffer.alloc(2 ** p);
    this.db
      .prepare(
        `INSERT INTO counters (name, p, rule_version, hash_name, registers)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name, p, RULE_VERSION, hashName, registers);
    const row = this.getCounterOrThrow(name);
    return {
      id: row.id,
      name: row.name,
      p: row.p,
      ruleVersion: row.ruleVersion,
      hashName: row.hashName,
      registerCount: row.registers.length,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  getCounter(name: string): CounterRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, p, rule_version AS ruleVersion, hash_name AS hashName,
                registers, created_at AS createdAt, updated_at AS updatedAt
         FROM counters WHERE name = ?`,
      )
      .get(name) as CounterRow | undefined;
    return row ? this.validateCounterRow(row) : undefined;
  }

  getCounterOrThrow(name: string): CounterRow {
    const row = this.getCounter(name);
    if (!row) throw new HllError('NOT_FOUND', `计数器 ${name} 不存在`);
    return row;
  }

  private validateCounterRow(row: CounterRow): CounterRow {
    const buf = toUint8(row.registers);
    if (![4, 5, 6, 7, 8, 9, 10, 11, 12].includes(row.p)) {
      throw new HllError('CORRUPT_STATE', `计数器 ${row.name} 的精度 ${row.p} 已损坏`);
    }
    validateRegisters(buf, 2 ** row.p);
    if (typeof row.ruleVersion !== 'string' || row.ruleVersion === '') {
      throw new HllError('CORRUPT_STATE', `计数器 ${row.name} 缺少规则版本`);
    }
    return { ...row, registers: buf };
  }

  listCounters(): Array<{ name: string; p: number; updatedAt: string }> {
    return this.db
      .prepare('SELECT name, p, updated_at AS updatedAt FROM counters ORDER BY id')
      .all() as Array<{ name: string; p: number; updatedAt: string }>;
  }

  // 原子保存寄存器：单条 UPDATE 包在事务中，重复键不会产生写入。
  replaceRegisters(name: string, registers: Uint8Array): void {
    const current = this.getCounterOrThrow(name);
    validateRegisters(registers, 2 ** current.p);
    const save = this.db.prepare(
      `UPDATE counters SET registers = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      save.run(Buffer.from(registers), current.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  saveSnapshot(input: {
    name: string;
    p: number;
    ruleVersion: string;
    hashName: string;
    registers: Uint8Array;
    sources: Array<{ kind: 'counter' | 'snapshot'; name: string }>;
  }): SnapshotRow {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new HllError('INVALID_NAME', '快照名称不能为空');
    }
    validateRegisters(input.registers, 2 ** input.p);
    const exists = this.db.prepare('SELECT id FROM snapshots WHERE name = ?').get(input.name);
    if (exists) throw new HllError('ALREADY_EXISTS', `快照 ${input.name} 已存在`);
    this.db
      .prepare(
        `INSERT INTO snapshots (name, p, rule_version, hash_name, registers, sources)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.p,
        input.ruleVersion,
        input.hashName,
        Buffer.from(input.registers),
        JSON.stringify(input.sources),
      );
    return this.getSnapshotOrThrow(input.name);
  }

  getSnapshot(name: string): SnapshotRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, p, rule_version AS ruleVersion, hash_name AS hashName,
                registers, sources, created_at AS createdAt
         FROM snapshots WHERE name = ?`,
      )
      .get(name) as SnapshotRow | undefined;
    if (!row) return undefined;
    const registers = toUint8(row.registers);
    validateRegisters(registers, 2 ** row.p);
    return { ...row, registers };
  }

  getSnapshotOrThrow(name: string): SnapshotRow {
    const row = this.getSnapshot(name);
    if (!row) throw new HllError('NOT_FOUND', `快照 ${name} 不存在`);
    return row;
  }

  listSnapshots(): Array<{ name: string; p: number; sources: string; createdAt: string }> {
    return this.db
      .prepare('SELECT name, p, sources, created_at AS createdAt FROM snapshots ORDER BY id')
      .all() as Array<{ name: string; p: number; sources: string; createdAt: string }>;
  }

  // 从导出文件导入：整体事务，任何一项损坏则全部拒绝。
  importAll(data: {
    counters?: Array<{
      name: string;
      p: number;
      ruleVersion: string;
      hashName: string;
      registersBase64: string;
    }>;
    snapshots?: Array<{
      name: string;
      p: number;
      ruleVersion: string;
      hashName: string;
      registersBase64: string;
      sources: unknown;
    }>;
  }): { counters: number; snapshots: number } {
    const parsedCounters = (data.counters ?? []).map((c) => {
      if (!c.name || typeof c.ruleVersion !== 'string') {
        throw new HllError('CORRUPT_STATE', '导出文件中计数器缺少名称或规则版本');
      }
      return { ...c, registers: decodeRegisters(c.registersBase64, c.p) };
    });
    const parsedSnapshots = (data.snapshots ?? []).map((s) => {
      if (!s.name || typeof s.ruleVersion !== 'string') {
        throw new HllError('CORRUPT_STATE', '导出文件中快照缺少名称或规则版本');
      }
      return { ...s, registers: decodeRegisters(s.registersBase64, s.p) };
    });
    this.db.exec('BEGIN');
    try {
      const insertCounter = this.db.prepare(
        `INSERT OR REPLACE INTO counters (name, p, rule_version, hash_name, registers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      );
      for (const c of parsedCounters) {
        insertCounter.run(c.name, c.p, c.ruleVersion, c.hashName, Buffer.from(c.registers));
      }
      const insertSnapshot = this.db.prepare(
        `INSERT OR REPLACE INTO snapshots (name, p, rule_version, hash_name, registers, sources)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const s of parsedSnapshots) {
        insertSnapshot.run(
          s.name,
          s.p,
          s.ruleVersion,
          s.hashName,
          Buffer.from(s.registers),
          JSON.stringify(s.sources ?? []),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { counters: parsedCounters.length, snapshots: parsedSnapshots.length };
  }

  exportAll(): {
    exportedAt: string;
    counters: Array<Record<string, unknown>>;
    snapshots: Array<Record<string, unknown>>;
  } {
    const counters = (
      this.db
        .prepare(
          `SELECT name, p, rule_version AS ruleVersion, hash_name AS hashName, registers
           FROM counters ORDER BY id`,
        )
        .all() as Array<{ name: string; p: number; ruleVersion: string; hashName: string; registers: unknown }>
    ).map((row) => ({
      name: row.name,
      p: row.p,
      ruleVersion: row.ruleVersion,
      hashName: row.hashName,
      registersBase64: Buffer.from(toUint8(row.registers)).toString('base64'),
    }));
    const snapshots = (
      this.db
        .prepare(
          `SELECT name, p, rule_version AS ruleVersion, hash_name AS hashName, registers, sources
           FROM snapshots ORDER BY id`,
        )
        .all() as Array<{
          name: string;
          p: number;
          ruleVersion: string;
          hashName: string;
          registers: unknown;
          sources: string;
        }>
    ).map((row) => ({
      name: row.name,
      p: row.p,
      ruleVersion: row.ruleVersion,
      hashName: row.hashName,
      registersBase64: Buffer.from(toUint8(row.registers)).toString('base64'),
      sources: JSON.parse(row.sources),
    }));
    return { exportedAt: new Date().toISOString(), counters, snapshots };
  }

  close(): void {
    this.db.close();
  }
}

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new HllError('CORRUPT_STATE', '寄存器字段不是 BLOB');
}
