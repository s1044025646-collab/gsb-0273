#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HllStore } from './store';
import { HllService } from './service';
import { createApp, findFreePort } from './http';
import { HllError } from './hll';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

const USAGE = `用法:
  hll serve [--port 8080] [--db ./data/hll.db]
  hll create <名称> --p 4..12 [--db ...]
  hll add <名称> --keys a,b,c [--keys-file keys.json] [--db ...]
  hll registers <名称> [--db ...]
  hll estimate <名称> [--db ...]
  hll merge <快照名称> --sources counter:c1,counter:c2,snapshot:s1 [--db ...]
  hll snapshot <名称> [--db ...]
  hll list [--db ...]
  hll export --file state.json [--db ...]
  hll import --file state.json [--db ...]

默认数据库为项目内 ./data/hll.db；serve 不指定 --port 时自动选择空闲端口。`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(flagString(args.flags, 'db') ?? resolve(process.cwd(), 'data', 'hll.db'));

  if (args.command === 'serve') {
    const store = new HllStore(dbPath);
    const service = new HllService(store);
    const server = createApp(service);
    const requestedPort = flagString(args.flags, 'port');
    const port = requestedPort ? Number(requestedPort) : await findFreePort();
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new HllError('INVALID_PORT', `非法端口 ${String(requestedPort)}`);
    }
    server.listen(port, '127.0.0.1', () => {
      console.log(JSON.stringify({ status: 'listening', host: '127.0.0.1', port, db: dbPath }));
    });
    return;
  }

  const store = new HllStore(dbPath);
  const service = new HllService(store);
  try {
    switch (args.command) {
      case 'create': {
        const name = args.positional[0];
        const p = Number(flagString(args.flags, 'p'));
        console.log(JSON.stringify(service.createCounter(name, p), null, 2));
        break;
      }
      case 'add': {
        const name = args.positional[0];
        const inline = flagString(args.flags, 'keys');
        const keysFile = flagString(args.flags, 'keys-file');
        let keys: unknown;
        if (keysFile) {
          keys = JSON.parse(readFileSync(resolve(keysFile), 'utf8'));
        } else {
          keys = inline === undefined ? [] : inline.split(',');
        }
        console.log(JSON.stringify(service.addKeys(name, keys), null, 2));
        break;
      }
      case 'registers':
        console.log(JSON.stringify(service.getRegisters(args.positional[0]), null, 2));
        break;
      case 'estimate':
        console.log(JSON.stringify(service.estimate(args.positional[0]), null, 2));
        break;
      case 'merge': {
        const snapshotName = args.positional[0];
        const sources = (flagString(args.flags, 'sources') ?? '')
          .split(',')
          .filter(Boolean)
          .map((entry) => {
            const [kind, name] = entry.split(':');
            if (kind !== 'counter' && kind !== 'snapshot') {
              throw new HllError('INVALID_SOURCE_KIND', `来源须为 counter:名称 或 snapshot:名称`);
            }
            return { kind: kind as 'counter' | 'snapshot', name };
          });
        console.log(JSON.stringify(service.mergeIntoSnapshot({ snapshotName, sources }), null, 2));
        break;
      }
      case 'snapshot':
        console.log(JSON.stringify(service.getSnapshot(args.positional[0]), null, 2));
        break;
      case 'list':
        console.log(
          JSON.stringify(
            { counters: service.listCounters(), snapshots: service.listSnapshots() },
            null,
            2,
          ),
        );
        break;
      case 'export': {
        const file = flagString(args.flags, 'file');
        if (!file) throw new HllError('INVALID_FILE', 'export 需要 --file');
        writeFileSync(resolve(file), JSON.stringify(service.exportState(), null, 2), 'utf8');
        console.log(JSON.stringify({ exported: resolve(file) }));
        break;
      }
      case 'import': {
        const file = flagString(args.flags, 'file');
        if (!file) throw new HllError('INVALID_FILE', 'import 需要 --file');
        const data = JSON.parse(readFileSync(resolve(file), 'utf8'));
        console.log(JSON.stringify(service.importState(data), null, 2));
        break;
      }
      default:
        console.log(USAGE);
        if (args.command) process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof HllError) {
    console.error(JSON.stringify({ error: { code: err.code, message: err.message } }));
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
