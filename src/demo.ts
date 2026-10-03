import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HllStore } from "./db.js";
import { estimate } from "./hll.js";

const dbPath = join(mkdtempSync(join(tmpdir(), "hll-demo-")), "demo.sqlite");
const store = new HllStore(dbPath);

const datasets: Record<string, string[]> = {
  small: ["", "Alpha", "alpha", " alpha", "2026", "重复", "重复"],
  medium: Array.from({ length: 200 }, (_unused, index) => `user-${index}`),
  mixed: Array.from({ length: 100 }, (_unused, index) => `team-${index % 25}`),
};

for (const [name, keys] of Object.entries(datasets)) {
  store.createCounter(name, 8);
  const result = store.addKeys(name, keys);
  const exact = new Set(keys).size;
  console.log(JSON.stringify({
    counter: name,
    exactSmallSampleVerification: exact,
    estimated: Number(result.estimate.estimatedCardinality.toFixed(2)),
    rawEstimate: Number(result.estimate.rawEstimate.toFixed(2)),
    zeroRegisters: result.estimate.zeroRegisters,
    correction: result.estimate.correctionApplied,
    relativeDifference: `${(Math.abs(result.estimate.estimatedCardinality - exact) / exact * 100).toFixed(2)}%`,
  }, null, 2));
}

store.addKeys("small", ["new-after-demo"]);
store.addKeys("medium", ["new-after-demo"]);
const snapshot = store.mergeToSnapshot("small-medium", ["small", "medium"]);
const unionKeys = [...new Set([...datasets.small!, ...datasets.medium!, "new-after-demo"])];
const result = estimate(snapshot.registers, snapshot.precision);
console.log(JSON.stringify({
  snapshot: "small-medium",
  exactUnionSmallSampleVerification: unionKeys.length,
  estimated: Number(result.estimatedCardinality.toFixed(2)),
  note: "精确集合仅用于演示对照，正式 SQLite 计数器只保存寄存器。",
  dbPath,
}, null, 2));
store.close();
