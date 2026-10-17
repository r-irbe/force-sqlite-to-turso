// Pure-logic + real-hook self-test. No network, no pi. The smoke check at
// the end loads the real better-sqlite3 vendored under pi-hermes through
// the actual NODE_OPTIONS hook in a child process.
'use strict';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const requireC = createRequire(import.meta.url);
const { expandVars, loadConfigFromObject, loadConfig } = requireC('./lib/config.cjs');
const { wrapDatabaseClass } = requireC('./lib/shim.cjs');
const server = requireC('./lib/server.cjs');
const route = requireC('./lib/route.cjs');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}: ${err && err.message}`);
    process.exitCode = 1;
  }
}

// 1. config expansion + defaults
check('config: env expansion and store normalization', () => {
  const cfg = loadConfigFromObject(
    { mode: 'telemetry', logFile: '${HOME}/x.log', stores: [{ match: '${HOME}/dbs/a.db' }, { notAStore: true }] },
    { HOME: '/h' },
    null,
  );
  if (cfg.logFile !== '/h/x.log') throw new Error(`logFile=${cfg.logFile}`);
  if (cfg.stores.length !== 1 || cfg.stores[0].match !== '/h/dbs/a.db') throw new Error('stores wrong');
  if (cfg.redactPath === false) throw new Error('redact default wrong');
});

// 2. degrade: requested sqld -> telemetry + degraded flag
check('config: sqld/libsql requests degrade to telemetry', () => {
  for (const requested of ['sqld', 'libsql']) {
    const cfg = loadConfigFromObject({ mode: requested }, {}, null);
    if (cfg.mode !== 'telemetry') throw new Error(`${requested} did not degrade`);
    if (cfg.requestedMode !== requested) throw new Error('requestedMode lost');
    if (cfg.degraded !== true) throw new Error('degraded flag missing');
  }
});

// 3. invalid/missing config is inert
check('config: garbage or absent config -> off', () => {
  if (loadConfigFromObject(null, {}, null).mode !== 'off') throw new Error('null not off');
  if (loadConfigFromObject({ mode: 'nonsense' }, {}, null).mode !== 'off') throw new Error('bad mode not off');
  const empty = loadConfig({ HOME: '/nonexistent-home-for-test' });
  if (empty.mode !== 'off') throw new Error('absent config not off');
});

// 4. telemetry wrapper counts and redacts
check('shim: telemetry wrapper counts ops, redacts path, hides sql', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fst-'));
  const logFile = path.join(dir, 't.log');
  const cfg = { mode: 'telemetry', degraded: false, logFile, logSqlText: false, stores: [] };

  class FakeDatabase {
    constructor(p) {
      this.path = p;
    }
    prepare() {
      return { run: () => 1, get: () => 2, all: () => [] };
    }
    exec() {
      return 'exec-ok';
    }
    pragma() {
      return [];
    }
  }
  const Wrapped = wrapDatabaseClass(FakeDatabase, cfg);
  if (Wrapped === FakeDatabase) throw new Error('telemetry returned original class');
  const db = new Wrapped('/secret/location/proj.db');
  const stmt = db.prepare('SELECT x');
  stmt.run();
  stmt.get();
  db.exec('CREATE TABLE t(a)');
  db.pragma('wal_checkpoint(TRUNCATE)');

  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ops = lines.map((l) => l.op);
  for (const want of ['prepare', 'stmt.run', 'stmt.get', 'exec', 'pragma']) {
    if (!ops.includes(want)) throw new Error(`missing op ${want}`);
  }
  for (const l of lines) {
    if (l.db === '/secret/location/proj.db') throw new Error('full path leaked to log');
    if (JSON.stringify(l).includes('SELECT x') || JSON.stringify(l).includes('CREATE TABLE')) {
      throw new Error('sql text leaked to log');
    }
    if (typeof l.ms !== 'number') throw new Error('timing missing');
  }
  rmSync(dir, { recursive: true, force: true });
});

// 5. off mode returns the original class untouched
check('shim: mode off is identity', () => {
  class F {}
  if (wrapDatabaseClass(F, { mode: 'off' }) !== F) throw new Error('off not identity');
});

// 6. real-hook smoke: child node process, NODE_OPTIONS preload, real vendored
// better-sqlite3, real :memory: database.
check('smoke: NODE_OPTIONS hook wraps real better-sqlite3 in a child process', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fst-smoke-'));
  const logFile = path.join(dir, 'smoke.log');
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ mode: 'telemetry', logFile }));
  const vendored = '/home/radu/.pi/agent/npm/node_modules/pi-hermes-memory/node_modules/better-sqlite3';
  if (!existsSync(vendored)) {
    console.log('   (vendored better-sqlite3 not present; smoke skipped)');
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const script = `const D=require(${JSON.stringify(vendored)}); const db=new D(':memory:');
db.exec('CREATE TABLE t(a)'); db.prepare('INSERT INTO t VALUES (1)').run();
process.exit(0);`;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${requireC.resolve('./register.cjs')}`,
      FORCE_SQLITE_TO_TURSO_CONFIG: cfgPath,
    },
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr && r.stderr.slice(0, 300)}`);
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ops = lines.map((l) => l.op);
  if (!ops.includes('exec') || !ops.includes('prepare') || !ops.includes('stmt.run')) {
    throw new Error(`hook did not capture ops: ${ops.join(',')}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

// --- phase 3 additions (sqld launcher + routing decisions) -----------------

check('config: sqld mode is operational with a server block, degrades without', () => {
  const home = '/home/h';
  const withServer = loadConfigFromObject({ mode: 'sqld', server: { command: 'node', healthUrl: 'http://127.0.0.1:1/health' } }, { HOME: home });
  if (withServer.mode !== 'sqld' || withServer.degraded) throw new Error('sqld+server should stay sqld');
  if (!withServer.server || withServer.server.command !== 'node') throw new Error('server block lost');
  const noServer = loadConfigFromObject({ mode: 'sqld' }, { HOME: home });
  if (noServer.mode !== 'telemetry' || !noServer.degraded) throw new Error('sqld without server must degrade');
  const lib = loadConfigFromObject({ mode: 'libsql' }, { HOME: home });
  if (lib.mode !== 'telemetry' || !lib.degraded) throw new Error('libsql must degrade');
});

check('server: status reports unconfigured / stopped / stale pid without throwing', () => {
  const cfg = loadConfigFromObject({ mode: 'telemetry' }, { HOME: tmpdir() });
  const s = server.status(cfg);
  if (s.state !== 'unconfigured') throw new Error(`expected unconfigured, got ${s.state}`);
  const stateDir = mkdtempSync(path.join(tmpdir(), 'fstt-state-'));
  const cfg2 = loadConfigFromObject({ mode: 'sqld', server: { command: process.execPath }, stateDir }, { HOME: tmpdir() });
  writeFileSync(server.pidPath(cfg2), '999999999');
  const s2 = server.status(cfg2);
  if (s2.state !== 'stopped' || !s2.stalePidFile) throw new Error(`expected stopped+stale, got ${JSON.stringify(s2)}`);
});

check('route: matched store routes only when healthy; unmatched never routes', () => {
  const cfg = loadConfigFromObject({ mode: 'sqld', server: { command: 'x' }, stores: [{ match: 'sessions.db' }] }, { HOME: tmpdir() });
  const hit = route.decide(cfg, '/x/sessions.db', true);
  if (!hit.routed || hit.decision !== 'pending-sync-bridge') throw new Error('healthy match should route');
  const down = route.decide(cfg, '/x/sessions.db', false);
  if (down.routed || down.decision !== 'telemetry-fallback') throw new Error('unhealthy match should fall back');
  const miss = route.decide(cfg, '/x/other.db', true);
  if (miss.routed || miss.reason !== 'no-store-match') throw new Error('unmatched must not route');
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) {
  console.error('self-test FAILED');
  process.exit(1);
}
