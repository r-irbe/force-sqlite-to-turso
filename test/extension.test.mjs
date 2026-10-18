// Pi-extension unit test: exercises the extension contract without pi and
// without the typebox dependency (createExtension takes a schema builder).
// Covers: session_start installs the in-process hook, a LATE require of
// better-sqlite3 is wrapped and telemetry-logged, both tools answer, a
// degraded config warns instead of throwing, and a broken config leaves the
// extension inert.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireC = createRequire(import.meta.url);
const { createExtension } = requireC('../extension.cjs');

const fakeType = {
  String: (opts) => ({ type: 'string', ...(opts || {}) }),
  Number: (opts) => ({ type: 'number', ...(opts || {}) }),
  Optional: (s) => ({ ...s, optional: true }),
  Object: (props) => ({ type: 'object', properties: props || {} }),
};

const fail = (msg) => { console.error(`EXTENSION FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok - ${msg}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fstt-ext-'));
const logFile = path.join(dir, 'telemetry.jsonl');
const cfgPath = path.join(dir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ mode: 'telemetry', logFile, logSqlText: false, stores: [] }));

// A fake better-sqlite3 package: the hook keys on the request path, so any
// module at .../node_modules/better-sqlite3 is treated as the real thing.
const fakePkg = path.join(dir, 'node_modules', 'better-sqlite3');
fs.mkdirSync(fakePkg, { recursive: true });
fs.writeFileSync(path.join(fakePkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-fake', main: 'index.js' }));
fs.writeFileSync(path.join(fakePkg, 'index.js'), `
'use strict';
class Database {
  constructor(file) { this.name = file; this.open = true; }
  prepare(sql) {
    return {
      run: () => ({ changes: 1, lastInsertRowid: 1 }),
      get: () => ({ v: 1 }),
      all: () => [{ v: 1 }],
      sql,
    };
  }
  exec() { return this; }
  pragma() { return [{ user_version: 0 }]; }
  close() { this.open = false; }
}
module.exports = Database;
module.exports.Database = Database;
`);

const handlers = {};
const tools = {};
const statuses = [];
const notes = [];
const pi = {
  on: (name, fn) => { handlers[name] = fn; },
  registerTool: (t) => { tools[t.name] = t; },
};
const ctx = {
  cwd: dir,
  hasUI: true,
  ui: {
    setStatus: (k, v) => statuses.push([k, v]),
    notify: (m, level) => notes.push([m, level]),
  },
};

process.env.FORCE_SQLITE_TO_TURSO_CONFIG = cfgPath;

const ext = createExtension({ Type: fakeType });
ext(pi);

if (!handlers.session_start) fail('session_start handler not registered');
if (!tools.sqlite_route_status || !tools.sqlite_route_doctor) fail('tools not registered');

await handlers.session_start({}, ctx);
if (!statuses.some(([k, v]) => k === 'force-sqlite-to-turso' && /telemetry/.test(v))) fail(`status line missing telemetry: ${JSON.stringify(statuses)}`);

// The LATE require (after session_start) must be wrapped by the hook.
const Late = requireC(fakePkg);
if (!Late.__forceSqliteToTurso) fail('late require was not wrapped by the in-process hook');
const db = new Late(path.join(dir, 'late.db'));
const stmt = db.prepare('SELECT 1 AS v');
const r = stmt.run();
if (!r || r.changes !== 1) fail('wrapped statement did not execute');
let logLines = [];
try { logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
if (!logLines.length) fail('telemetry log empty after a wrapped operation');
else ok(`late require wrapped; ${logLines.length} telemetry event(s) logged`);

// Tools answer with parseable JSON / diagnostic rows.
const statusRes = await tools.sqlite_route_status.execute('t1', { events: 3 }, null, null, ctx);
const statusOut = JSON.parse(statusRes.content[0].text);
if (statusOut.config.mode !== 'telemetry') fail(`status mode: ${statusOut.config.mode}`);
if (!Array.isArray(statusOut.events)) fail('status events not an array');
ok('sqlite_route_status returns config, server state, and recent events');

const doctorRes = await tools.sqlite_route_doctor.execute('t2', {}, null, null, ctx);
const doctorText = doctorRes.content[0].text;
if (!/mode\s+telemetry/.test(doctorText)) fail(`doctor text unexpected: ${doctorText}`);
if (!/stores/.test(doctorText)) fail('doctor missing stores row');
ok('sqlite_route_doctor returns the diagnostic rows');

// Degraded config: warn, never throw.
const degradedPath = path.join(dir, 'degraded.json');
fs.writeFileSync(degradedPath, JSON.stringify({ mode: 'sqld' }));
process.env.FORCE_SQLITE_TO_TURSO_CONFIG = degradedPath;
notes.length = 0;
await handlers.session_start({}, ctx);
if (!notes.some(([m, level]) => /inactive/.test(m) && level === 'warning')) fail(`degraded config did not warn: ${JSON.stringify(notes)}`);
ok('a degraded config warns with the reason instead of throwing');

// Broken config (invalid JSON): loadConfig falls back to inert defaults.
const brokenPath = path.join(dir, 'broken.json');
fs.writeFileSync(brokenPath, '{not json');
process.env.FORCE_SQLITE_TO_TURSO_CONFIG = brokenPath;
try {
  await handlers.session_start({}, ctx);
  ok('a broken config leaves the extension inert (no throw)');
} catch (err) {
  fail(`broken config threw: ${err.message}`);
}

process.env.FORCE_SQLITE_TO_TURSO_CONFIG = cfgPath;
if (!process.exitCode) console.log('EXTENSION TEST OK: hook install, late-require wrapping, tools, degraded + broken config safety');
