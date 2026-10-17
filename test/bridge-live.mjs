// Live end-to-end test for the sync bridge: real Hrana server (the loomdb
// data plane, started through the product's own launcher), real
// better-sqlite3-shaped synchronous calls. Verifies values exactly:
// changes/lastInsertRowid, get/all, pluck/raw, blob round-trips as Buffers,
// multi-statement exec, transaction commit and rollback, pragma, close.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireC = createRequire(import.meta.url);
const HOME = os.homedir();
const PLANE_BIN = process.env.LOOMDB_PLANE_BIN || path.join(HOME, 'code', 'loomdb', 'packages', 'data-plane', 'bin', 'loomdb-plane.cjs');
const PORT = Number(process.env.BRIDGE_LIVE_PORT || 8092);
const URL = `http://127.0.0.1:${PORT}`;

const { BridgeDatabase } = requireC('../lib/bridge.cjs');
const server = requireC('../lib/server.cjs');
const { loadConfigFromObject } = requireC('../lib/config.cjs');

if (!fs.existsSync(PLANE_BIN)) {
  console.error(`BRIDGE LIVE SKIP: plane binary not found at ${PLANE_BIN}`);
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fstt-bridge-live-'));
const planeCfgPath = path.join(dir, 'plane.json');
fs.writeFileSync(planeCfgPath, JSON.stringify({
  socket: path.join(dir, 'plane.sock'),
  pidFile: path.join(dir, 'plane.pid'),
  logFile: path.join(dir, 'plane.log'),
  readers: 2,
  ring: { slotBytes: 1024, slots: 1024 },
  hrana: { port: PORT },
  dbs: { main: path.join(dir, 'main.db') },
}, null, 2));

const launcherCfg = loadConfigFromObject({
  mode: 'sqld',
  stateDir: dir,
  server: {
    command: process.execPath,
    args: [PLANE_BIN, 'start', '--config', planeCfgPath],
    healthUrl: `${URL}/health`,
    url: URL,
    startTimeoutMs: 20000,
  },
}, { HOME: dir });

const fail = (msg) => { console.error(`BRIDGE LIVE FAIL: ${msg}`); process.exitCode = 1; };
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) fail(`${name}: got ${g}, want ${w}`);
  else console.log(`ok - ${name}`);
};

try {
  const start = await server.start(launcherCfg);
  if (!start.ok) throw new Error(`launcher start failed: ${start.detail}`);

  const db = new BridgeDatabase('test.db', { server: { url: URL } });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, payload BLOB); CREATE TABLE u (x INTEGER)');
  eq('exec multi-statement', db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('t','u')").get().n, 2);

  const ins = db.prepare('INSERT INTO t (name, payload) VALUES (?, ?)');
  const r1 = ins.run('alpha', Buffer.from('hello-blob'));
  eq('run #1 changes', r1.changes, 1);
  eq('run #1 lastInsertRowid', r1.lastInsertRowid, 1);
  const r2 = db.prepare('INSERT INTO t (name) VALUES (?)').run('beta');
  eq('run #2 lastInsertRowid', r2.lastInsertRowid, 2);
  db.prepare('INSERT INTO u (x) VALUES (?)').run(7);

  eq('get by named-style positional', db.prepare('SELECT name FROM t WHERE id = ?').get(1).name, 'alpha');
  eq('get miss is undefined', db.prepare('SELECT name FROM t WHERE id = ?').get(99), undefined);
  eq('all rows ordered', db.prepare('SELECT id, name FROM t ORDER BY id').all().map((r) => [r.id, r.name]), [[1, 'alpha'], [2, 'beta']]);
  eq('pluck', db.prepare('SELECT name FROM t ORDER BY id').pluck().all(), ['alpha', 'beta']);
  eq('raw', db.prepare('SELECT id, name FROM t WHERE id = 1').raw().get(), [1, 'alpha']);

  const blobRow = db.prepare('SELECT payload FROM t WHERE id = 1').get();
  eq('blob is a Buffer', Buffer.isBuffer(blobRow.payload), true);
  eq('blob bytes exact', blobRow.payload.toString(), 'hello-blob');

  // Named args (object form) against a named placeholder.
  eq('named args', db.prepare('SELECT name FROM t WHERE name = :name').get({ name: 'beta' }).name, 'beta');

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO t (name) VALUES (?)').run('gamma');
    return 'done';
  });
  eq('transaction return value', tx(), 'done');
  eq('transaction committed', db.prepare('SELECT count(*) AS n FROM t').get().n, 3);
  eq('inTransaction false after commit', db.inTransaction, false);

  try {
    db.transaction(() => {
      db.prepare('INSERT INTO t (name) VALUES (?)').run('delta');
      throw new Error('boom');
    })();
    fail('rollback: transaction did not throw');
  } catch (err) {
    eq('rollback rethrows the application error', err.message, 'boom');
  }
  eq('rollback discarded the insert', db.prepare('SELECT count(*) AS n FROM t').get().n, 3);

  const pragmaRows = db.pragma('user_version');
  eq('pragma returns an array', Array.isArray(pragmaRows), true);

  // Unsupported surface throws with a config hint (the agent's escape hatch).
  let unsupported = null;
  try { db.function('f', () => 1); } catch (err) { unsupported = err; }
  eq('db.function throws BRIDGE_UNSUPPORTED', unsupported && unsupported.code, 'BRIDGE_UNSUPPORTED');
  eq('hint names the config key', /"route": "sqlite"/.test(String(unsupported && unsupported.message)), true);

  db.close();
  eq('close', db.open, false);

  if (!process.exitCode) console.log('BRIDGE LIVE OK: synchronous API over Hrana, values exact');
} catch (err) {
  console.error(`BRIDGE LIVE FAIL: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  try { await server.stop(launcherCfg); } catch { /* best effort */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* debugging */ }
}
