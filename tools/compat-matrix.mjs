// Per-agent compatibility matrix: does each installed coding agent LAUNCH
// cleanly with the NODE_OPTIONS preload active, and does the hook observe
// database activity? Honest scope: a --version probe proves launch
// compatibility and that NODE_OPTIONS injection does not break the agent; it
// does not exercise the agent's own DB code paths (that is what the
// telemetry phase is for - run a real session with mode=telemetry and read
// the log).
//
// Usage: node tools/compat-matrix.mjs [--json] [--timeout <ms>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const REGISTER = path.join(REPO, 'register.cjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const TIMEOUT_MS = Number(arg('--timeout', '30000'));
const JSON_OUT = process.argv.includes('--json');
const AGENTS = ['pi', 'claude', 'codex', 'cursor-agent', 'gemini'];

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

function probe(name) {
  const bin = which(name);
  if (!bin) return { agent: name, found: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fstt-compat-${name}-`));
  const logFile = path.join(dir, 'telemetry.jsonl');
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ mode: 'telemetry', logFile, logSqlText: false, stores: [] }));
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require ${REGISTER}`,
    FORCE_SQLITE_TO_TURSO_CONFIG: cfgPath,
  };
  const t0 = Date.now();
  const r = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: TIMEOUT_MS });
  const ms = Date.now() - t0;
  const version = String(r.stdout || r.stderr || '').trim().split('\n').slice(0, 2).join(' | ').slice(0, 120);
  const events = [];
  try {
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch { /* torn */ }
    }
  } catch { /* no log: the agent never loaded better-sqlite3 */ }
  const ops = events.reduce((m, e) => { m[e.op] = (m[e.op] || 0) + 1; return m; }, {});
  const preloadError = /register\.cjs|force-sqlite-to-turso|Cannot find module/i.test(`${r.stderr || ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    agent: name,
    found: true,
    binary: bin,
    version,
    exit: r.status,
    signal: r.signal || null,
    ms,
    hookLoaded: !preloadError && (r.status !== null),
    preloadError,
    dbOps: ops,
    dbOpCount: events.length,
    degraded: events.filter((e) => e.op === 'mode_degraded').length,
  };
}

const rows = AGENTS.map(probe);

if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), register: REGISTER, rows }, null, 2));
} else {
  console.log(`Agent compatibility matrix - ${new Date().toISOString().slice(0, 10)}`);
  console.log(`preload: ${REGISTER}\n`);
  const cols = ['agent', 'found', 'exit', 'ms', 'version', 'hook', 'db ops (during --version)'];
  const data = rows.map((r) => [
    r.agent,
    r.found ? 'yes' : 'no',
    r.found ? String(r.exit) : '-',
    r.found ? String(r.ms) : '-',
    r.found ? r.version.slice(0, 60) : '-',
    r.found ? (r.preloadError ? 'PRELOAD ERROR' : 'clean') : '-',
    r.found ? (r.dbOpCount ? JSON.stringify(r.dbOps) : 'none') : '-',
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const d of data) console.log(line(d));
  console.log('\nNote: --version probes prove launch compatibility and clean NODE_OPTIONS injection.');
  console.log('They do not exercise agent DB paths; run a real session with mode=telemetry for that.');
  if (rows.some((r) => r.preloadError)) process.exitCode = 1;
}
