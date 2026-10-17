// Chaos harness for phase 3 (sqld mode): N agent-like clients against a real
// single-writer Hrana server, SIGKILL the server mid-transaction, restart,
// and assert ZERO LOST COMMITTED WRITES.
//
// The server is started and restarted through the PRODUCT'S OWN launcher
// (lib/server.cjs) - so this test exercises both the durability claim and
// the lifecycle code. Server under test: the loomdb data plane (the
// reference Hrana v2 JSON implementation on this machine; a real sqld binary
// works identically). Client: the stock @libsql/client from a sibling loomdb
// checkout (test-only coupling; the product stays dependency-free).
//
// Exit 0 + "CHAOS OK" on success; non-zero with the failure detail otherwise.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const requireC = createRequire(import.meta.url);
const HOME = os.homedir();
const PLANE_BIN = process.env.LOOMDB_PLANE_BIN || path.join(HOME, 'code', 'loomdb', 'packages', 'data-plane', 'bin', 'loomdb-plane.cjs');
const LOOMDB_REQUIRE = createRequire(path.join(HOME, 'code', 'loomdb', 'package.json'));
const PORT = 8091;
const URL = `http://127.0.0.1:${PORT}`;
const WRITERS = 6;
const OPS = 40;

const server = requireC('../lib/server.cjs');
const { loadConfigFromObject } = requireC('../lib/config.cjs');

if (!fs.existsSync(PLANE_BIN)) {
  console.error(`CHAOS SKIP: plane binary not found at ${PLANE_BIN} (set LOOMDB_PLANE_BIN)`);
  process.exit(0);
}
let createClient;
try {
  ({ createClient } = LOOMDB_REQUIRE('@libsql/client'));
} catch {
  console.error('CHAOS SKIP: @libsql/client unavailable in the loomdb checkout');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fstt-chaos-'));
const cfgPath = path.join(dir, 'plane.json');
const dbPath = path.join(dir, 'main.db');
fs.writeFileSync(cfgPath, JSON.stringify({
  socket: path.join(dir, 'plane.sock'),
  pidFile: path.join(dir, 'plane.pid'),
  logFile: path.join(dir, 'plane.log'),
  readers: 2,
  ring: { slotBytes: 1024, slots: 1024 },
  hrana: { port: PORT },
  dbs: { main: dbPath },
}, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthOk() {
  try {
    const res = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealth(up, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await healthOk()) === up) return;
    await sleep(100);
  }
  throw new Error(`plane did not become ${up ? 'healthy' : 'unreachable'} in time`);
}

const writerScript = `
const { createClient } = require(${JSON.stringify(path.join(HOME, 'code', 'loomdb', 'node_modules', '@libsql', 'client', 'lib-cjs', 'node.js'))});
(async () => {
  const [url, w, ops] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])];
  const client = createClient({ url });
  for (let k = 0; k < ops; k += 1) {
    const tag = 'w' + w + '-' + k;
    let done = false;
    for (let attempt = 0; attempt < 120 && !done; attempt += 1) {
      try {
        const r = await client.execute({ sql: 'INSERT OR IGNORE INTO chaos (tag, w) VALUES (?, ?)', args: [tag, w] });
        if (r) { console.log('ACK ' + tag); done = true; }
      } catch {
        await new Promise((res) => setTimeout(res, 50));
      }
    }
    if (!done) console.log('FAILED ' + tag);
  }
  try { client.close(); } catch {}
  process.exit(0);
})().catch((e) => { console.error('writer fatal:', e && e.message); process.exit(1); });
`;

// One launcher config for the plane: any Hrana server command works; this is
// the reference implementation on this machine.
const cfg = loadConfigFromObject({
  mode: 'sqld',
  stateDir: dir,
  server: {
    command: process.execPath,
    args: [PLANE_BIN, 'start', '--config', cfgPath],
    healthUrl: `${URL}/health`,
    url: URL,
    startTimeoutMs: 20000,
  },
  stores: [{ match: 'main.db' }],
}, { HOME: dir });

async function main() {
  // Precondition: nothing may already be serving on the port. The launcher
  // must own the lifecycle, and a stale server would make every assertion
  // meaningless (learned the hard way: a self-daemonized leftover answered
  // health while a fresh spawn died on the bound port).
  if (await healthOk()) {
    throw new Error(`port ${PORT} already serves health; kill the stale server before running chaos`);
  }
  console.log(`chaos: plane via the product launcher, ${URL}, db ${dbPath}`);
  const first = await server.start(cfg);
  if (!first.ok) throw new Error(`launcher start failed: ${first.detail}`);
  if (first.state === 'self-daemonized') throw new Error(`launcher: ${first.warning}`);
  if (!server.readPid(cfg)) throw new Error('launcher recorded no live pid');
  await waitHealth(true);

  const client = createClient({ url: URL });
  await client.execute('CREATE TABLE IF NOT EXISTS chaos (tag TEXT PRIMARY KEY, w INTEGER NOT NULL)');
  client.close();

  // Collect each writer's output AT SPAWN TIME: a writer that exits during
  // the server downtime must not orphan a close-listener attached later
  // (that race left the harness on an unsettled top-level await).
  const writerRuns = [];
  for (let w = 0; w < WRITERS; w += 1) {
    const child = spawn(process.execPath, ['-e', writerScript, URL, String(w), String(OPS)], { stdio: ['ignore', 'pipe', 'pipe'] });
    writerRuns.push(new Promise((resolve) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.stderr.on('data', (d) => { buf += d; });
      const timer = setTimeout(() => resolve({ out: buf, timedOut: true }), 120000);
      child.on('close', () => { clearTimeout(timer); resolve({ out: buf, timedOut: false }); });
    }));
  }

  await sleep(400);
  const pid = server.readPid(cfg);
  if (!pid) throw new Error('no pid from the launcher');
  process.kill(pid, 'SIGKILL');
  console.log(`chaos: SIGKILL ${pid} mid-run`);
  await waitHealth(false);
  await sleep(150);
  const second = await server.start(cfg);
  if (!second.ok) throw new Error(`launcher restart failed: ${second.detail}`);
  console.log('chaos: server restarted through the launcher');

  const acked = [];
  const failed = [];
  const runs = await Promise.all(writerRuns);
  for (const run of runs) {
    if (run.timedOut) console.log('chaos: WARNING a writer did not exit within the watchdog; counting its partial output');
    for (const line of run.out.split('\n')) {
      if (line.startsWith('ACK ')) acked.push(line.slice(4).trim());
      else if (line.startsWith('FAILED ')) failed.push(line.slice(7).trim());
    }
  }

  const verify = createClient({ url: URL });
  const total = (await verify.execute('SELECT count(*) AS n FROM chaos')).rows[0].n;
  let missing = 0;
  for (const tag of acked) {
    const n = (await verify.execute({ sql: 'SELECT count(*) AS n FROM chaos WHERE tag = ?', args: [tag] })).rows[0].n;
    if (Number(n) !== 1) missing += 1;
  }
  const integrity = (await verify.execute('PRAGMA integrity_check')).rows;
  verify.close();

  console.log(`chaos: acked=${acked.length} failed=${failed.length} rows=${total} missing_acked=${missing} integrity=${JSON.stringify(integrity.slice(0, 1))}`);
  const ok = missing === 0 && Number(total) === acked.length && String(JSON.stringify(integrity)).includes('ok');
  if (!ok) {
    console.error('CHAOS FAIL: committed-write loss or duplicate detected');
    try {
      const log = fs.readFileSync(path.join(dir, 'plane.log'), 'utf8');
      console.error('plane log tail:');
      console.error(log.slice(-2500));
    } catch { /* no log */ }
    console.error(`artifacts kept at ${dir}`);
    process.exitCode = 1;
    return;
  }
  console.log('CHAOS OK: zero lost committed writes across SIGKILL + restart');
}

try {
  await main();
} finally {
  try { await server.stop(cfg); } catch { /* best effort */ }
  if (!process.exitCode) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* keep for debugging */ }
  } else {
    console.error(`(artifacts preserved for the post-mortem: ${dir})`);
  }
}
