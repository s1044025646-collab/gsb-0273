#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HllStore } from "./db.js";
import { estimate } from "./hll.js";
import { startServer } from "./server.js";

const args = process.argv.slice(2);
const command = args[0];
const dbPath = process.env.HLL_DB ?? "data/hll.sqlite";

try {
  switch (command) {
    case "serve": {
      const portIndex = args.indexOf("--port");
      const hostIndex = args.indexOf("--host");
      const port = portIndex >= 0 ? parsePort(args[portIndex + 1]) : undefined;
      const host = hostIndex >= 0 ? args[hostIndex + 1] : "127.0.0.1";
      const options = {
        dbPath,
        ...(host === undefined ? {} : { host }),
        ...(port === undefined ? {} : { port }),
      };
      const running = await startServer(options);
      console.log(`HyperLogLog 服务已启动: http://${host}:${running.port}`);
      console.log(`SQLite 数据文件: ${resolve(dbPath)}`);
      break;
    }
    case "create":
      withStore((store) => print(store.createCounter(requireArg(args[1], "计数器名称"), parsePrecision(args[2]))));
      break;
    case "list":
      withStore((store) => print(store.listCounters()));
      break;
    case "add": {
      const [, name, ...keys] = args;
      withStore((store) => print(store.addKeys(requireArg(name, "计数器名称"), readKeys(keys))));
      break;
    }
    case "registers":
      withStore((store) => print(store.getCounter(requireArg(args[1], "计数器名称"))));
      break;
    case "estimate":
      withStore((store) => {
        const counter = store.getCounter(requireArg(args[1], "计数器名称"));
        print({ name: counter.name, ...estimate(counter.registers, counter.precision) });
      });
      break;
    case "merge": {
      const snapshotName = requireArg(args[1], "快照名称");
      const sources = args.slice(2);
      withStore((store) => print(store.mergeToSnapshot(snapshotName, sources)));
      break;
    }
    case "snapshot":
      withStore((store) => print(store.getSnapshot(requireArg(args[1], "快照名称"))));
      break;
    case "export": {
      const output = args[1] ?? "data/hll-export.json";
      withStore((store) => {
        writeFileSync(output, `${JSON.stringify(store.exportState(), null, 2)}\n`, "utf8");
        console.log(`已导出到 ${output}`);
      });
      break;
    }
    case "import": {
      const input = requireArg(args[1], "导入文件路径");
      withStore((store) => print({ imported: store.importState(JSON.parse(readFileSync(input, "utf8")) as unknown) }));
      break;
    }
    default:
      printUsage();
      process.exitCode = 2;
  }
} catch (error) {
  if (isAppErrorLike(error)) {
    console.error(JSON.stringify({ code: error.code, message: error.message }, null, 2));
    process.exitCode = 4;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}

function withStore<T>(action: (store: HllStore) => T): T {
  const store = new HllStore(dbPath);
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function readKeys(values: string[]): string[] {
  const fileIndex = values.indexOf("--file");
  if (fileIndex >= 0) {
    const filePath = requireArg(values[fileIndex + 1], "--file 路径");
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== "string")) {
      throw { code: "INVALID_KEYS", message: "--file 内容必须是字符串 JSON 数组。" };
    }
    return parsed;
  }
  return values;
}

function parsePrecision(value: string | undefined): number {
  const precision = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(precision) || precision < 4 || precision > 12) {
    throw { code: "INVALID_PRECISION", message: "精度 p 必须是 4 到 12 的整数。" };
  }
  return precision;
}

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw { code: "BAD_REQUEST", message: "端口必须是 1 到 65535 的整数。" };
  }
  return port;
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) throw { code: "BAD_REQUEST", message: `缺少参数：${label}` };
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function isAppErrorLike(error: unknown): error is { code: string; message: string } {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string";
}

function printUsage(): void {
  console.log(`用法:
  npm start -- serve [--host 127.0.0.1] [--port 5173]
  npm start -- create <名称> <p=4..12>
  npm start -- list
  npm start -- add <名称> <键...> [或 --file keys.json]
  npm start -- registers <名称>
  npm start -- estimate <名称>
  npm start -- merge <快照名称> <来源计数器...>
  npm start -- snapshot <快照名称>
  npm start -- export [输出.json]
  npm start -- import <输入.json>`);
}
