import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type HllState,
  RULE_VERSION,
  addKey,
  createRegisters,
  estimate,
  mergeStates,
  validateState,
} from "./hll.js";
import { AppError } from "./errors.js";

export interface CounterRecord extends HllState {
  name: string;
  createdAt: string;
  updatedAt: string;
}

function parseRegisters(text: string, precision: number): number[] {
  try {
    const registers = JSON.parse(text) as unknown;
    validateState({
      precision,
      hashAlgorithm: "SHA-256",
      hashBits: 64,
      ruleVersion: RULE_VERSION,
      registers,
    });
    return registers as number[];
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError("INVALID_STATE", "SQLite 中的计数器状态已损坏。", 500, error.details);
    }
    throw new AppError("INVALID_STATE", "SQLite 中的寄存器 JSON 已损坏。", 500);
  }
}

function rowToCounter(row: CounterRow): CounterRecord {
  return {
    name: row.name,
    precision: row.precision,
    hashAlgorithm: row.hash_algorithm,
    hashBits: row.hash_bits,
    ruleVersion: row.rule_version,
    registers: parseRegisters(row.registers, row.precision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSnapshot(row: SnapshotRow): SnapshotRecord {
  let sources: unknown;
  try {
    sources = JSON.parse(row.sources);
  } catch {
    throw new AppError("INVALID_STATE", "SQLite 中的快照来源已损坏。", 500);
  }
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== "string")) {
    throw new AppError("INVALID_STATE", "SQLite 中的快照来源已损坏。", 500);
  }
  return {
    name: row.name,
    precision: row.precision,
    hashAlgorithm: row.hash_algorithm,
    hashBits: row.hash_bits,
    ruleVersion: row.rule_version,
    registers: parseRegisters(row.registers, row.precision),
    sources: sources as string[],
    createdAt: row.created_at,
  };
}

function isExportBundle(value: unknown): value is ExportBundle {
  return typeof value === "object" && value !== null
    && (value as { format?: unknown }).format === "local-hll-export"
    && (value as { formatVersion?: unknown }).formatVersion === 1
    && Array.isArray((value as { counters?: unknown }).counters)
    && Array.isArray((value as { snapshots?: unknown }).snapshots);
}

function isSqliteUniqueError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && ["SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE"]
      .includes((error as { code?: string }).code ?? "");
}

export interface SnapshotRecord extends HllState {
  name: string;
  sources: string[];
  createdAt: string;
}

export interface ExportBundle {
  format: "local-hll-export";
  formatVersion: 1;
  exportedAt: string;
  counters: CounterRecord[];
  snapshots: SnapshotRecord[];
}

interface CounterRow {
  name: string;
  precision: number;
  hash_algorithm: "SHA-256";
  hash_bits: 64;
  rule_version: typeof RULE_VERSION;
  registers: string;
  created_at: string;
  updated_at: string;
}

interface SnapshotRow {
  name: string;
  precision: number;
  hash_algorithm: "SHA-256";
  hash_bits: 64;
  rule_version: typeof RULE_VERSION;
  registers: string;
  sources: string;
  created_at: string;
}

export function validateName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new AppError("INVALID_NAME", "名称只能包含 1 到 64 个字母、数字、下划线、点或短横线。", 400, {
      received: name,
    });
  }
}

export class HllStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const absolutePath = resolve(dbPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new DatabaseSync(absolutePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        precision INTEGER NOT NULL CHECK(precision BETWEEN 4 AND 12),
        hash_algorithm TEXT NOT NULL CHECK(hash_algorithm = 'SHA-256'),
        hash_bits INTEGER NOT NULL CHECK(hash_bits = 64),
        rule_version TEXT NOT NULL CHECK(rule_version = '${RULE_VERSION}'),
        registers TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        name TEXT PRIMARY KEY,
        precision INTEGER NOT NULL CHECK(precision BETWEEN 4 AND 12),
        hash_algorithm TEXT NOT NULL CHECK(hash_algorithm = 'SHA-256'),
        hash_bits INTEGER NOT NULL CHECK(hash_bits = 64),
        rule_version TEXT NOT NULL CHECK(rule_version = '${RULE_VERSION}'),
        registers TEXT NOT NULL,
        sources TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createCounter(name: string, precision: number): CounterRecord {
    validateName(name);
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO counters
            (name, precision, hash_algorithm, hash_bits, rule_version, registers, created_at, updated_at)
           VALUES (?, ?, 'SHA-256', 64, ?, ?, ?, ?)`,
        )
        .run(name, precision, RULE_VERSION, JSON.stringify(createRegisters(precision)), now, now);
    } catch (error) {
      if (isSqliteUniqueError(error)) {
        throw new AppError("CONFLICT", `计数器 ${name} 已存在。`, 409);
      }
      throw error;
    }
    return this.getCounter(name);
  }

  listCounters(): CounterRecord[] {
    return this.db.prepare("SELECT * FROM counters ORDER BY name").all().map((row) => rowToCounter(row as unknown as CounterRow));
  }

  getCounter(name: string): CounterRecord {
    validateName(name);
    const row = this.db.prepare("SELECT * FROM counters WHERE name = ?").get(name) as unknown as CounterRow | undefined;
    if (!row) throw new AppError("COUNTER_NOT_FOUND", `计数器 ${name} 不存在。`, 404);
    return rowToCounter(row);
  }

  addKeys(name: string, keys: readonly string[]) {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
      throw new AppError("INVALID_KEYS", "批量加入内容必须是字符串数组；空字符串是有效键。", 400);
    }
    if (keys.length === 0 || keys.length > 100_000) {
      throw new AppError("INVALID_KEYS", "每批必须包含 1 到 100000 个字符串。", 400);
    }
    const record = this.getCounter(name);
    const registers = record.registers.slice();
    let changed = 0;
    for (const key of keys) {
      if (addKey(registers, record.precision, key)) changed += 1;
    }
    if (changed > 0) this.replaceRegisters(name, record, registers);
    return { changed, totalKeys: keys.length, estimate: estimate(registers, record.precision) };
  }

  mergeToSnapshot(snapshotName: string, sourceNames: readonly string[]): SnapshotRecord {
    validateName(snapshotName);
    if (!Array.isArray(sourceNames) || sourceNames.length < 2 || sourceNames.some((source) => typeof source !== "string")) {
      throw new AppError("BAD_REQUEST", "合并至少需要两个来源名称。", 400);
    }
    if (new Set(sourceNames).size !== sourceNames.length) {
      throw new AppError("BAD_REQUEST", "合并来源不能重复。", 400);
    }
    const sources = sourceNames.map((sourceName) => this.getCounter(sourceName));
    const merged = mergeStates(sources.map((source) => ({
      precision: source.precision,
      hashAlgorithm: source.hashAlgorithm,
      hashBits: source.hashBits,
      ruleVersion: source.ruleVersion,
      registers: source.registers,
    })));
    try {
      this.db
        .prepare(
          `INSERT INTO snapshots
            (name, precision, hash_algorithm, hash_bits, rule_version, registers, sources, created_at)
           VALUES (?, ?, 'SHA-256', 64, ?, ?, ?, ?)`,
        )
        .run(snapshotName, merged.precision, RULE_VERSION, JSON.stringify(merged.registers),
          JSON.stringify(sourceNames), new Date().toISOString());
    } catch (error) {
      if (isSqliteUniqueError(error)) {
        throw new AppError("CONFLICT", `快照 ${snapshotName} 已存在。`, 409);
      }
      throw error;
    }
    return this.getSnapshot(snapshotName);
  }

  getSnapshot(name: string): SnapshotRecord {
    validateName(name);
    const row = this.db.prepare("SELECT * FROM snapshots WHERE name = ?").get(name) as unknown as SnapshotRow | undefined;
    if (!row) throw new AppError("SNAPSHOT_NOT_FOUND", `快照 ${name} 不存在。`, 404);
    return rowToSnapshot(row);
  }

  listSnapshots(): SnapshotRecord[] {
    return this.db.prepare("SELECT * FROM snapshots ORDER BY name").all().map((row) => rowToSnapshot(row as unknown as SnapshotRow));
  }

  exportState(): ExportBundle {
    return {
      format: "local-hll-export",
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      counters: this.listCounters(),
      snapshots: this.listSnapshots(),
    };
  }

  importState(bundle: unknown): { counters: number; snapshots: number } {
    if (!isExportBundle(bundle)) {
      throw new AppError("INVALID_STATE", "导入文件不是受支持的 local-hll-export v1 状态。", 422);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const counter of bundle.counters) {
        validateName(counter.name);
        validateState(counter);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO counters
              (name, precision, hash_algorithm, hash_bits, rule_version, registers, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(counter.name, counter.precision, counter.hashAlgorithm, counter.hashBits,
            counter.ruleVersion, JSON.stringify(counter.registers), counter.createdAt, counter.updatedAt);
      }
      for (const snapshot of bundle.snapshots) {
        validateName(snapshot.name);
        validateState(snapshot);
        if (!Array.isArray(snapshot.sources) || snapshot.sources.some((source) => typeof source !== "string")) {
          throw new AppError("INVALID_STATE", "快照来源必须是字符串数组。", 422);
        }
        this.db
          .prepare(
            `INSERT OR REPLACE INTO snapshots
              (name, precision, hash_algorithm, hash_bits, rule_version, registers, sources, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(snapshot.name, snapshot.precision, snapshot.hashAlgorithm, snapshot.hashBits,
            snapshot.ruleVersion, JSON.stringify(snapshot.registers), JSON.stringify(snapshot.sources),
            snapshot.createdAt);
      }
      this.db.exec("COMMIT");
      return { counters: bundle.counters.length, snapshots: bundle.snapshots.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private replaceRegisters(name: string, previous: CounterRecord, registers: number[]): void {
    const updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT registers, updated_at FROM counters WHERE name = ?").get(name) as
        | Pick<CounterRow, "registers" | "updated_at">
        | undefined;
      if (!row) throw new AppError("COUNTER_NOT_FOUND", `计数器 ${name} 不存在。`, 404);
      if (row.registers !== JSON.stringify(previous.registers) || row.updated_at !== previous.updatedAt) {
        throw new AppError("CONFLICT", "状态已被其他操作修改，请重试。", 409);
      }
      this.db.prepare("UPDATE counters SET registers = ?, updated_at = ? WHERE name = ?")
        .run(JSON.stringify(registers), updatedAt, name);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
