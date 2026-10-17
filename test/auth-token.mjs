// Auth-path test for libsql mode: the bridge must send the configured Bearer
// token, and a wrong/absent token must fail loudly at open (never silently
// proceed unauthenticated). The stub endpoint runs in a CHILD PROCESS: the
// bridge blocks its caller's thread in Atomics.wait, so an in-process server
// could never answer (that design error was caught by this test's first run).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireC = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { BridgeDatabase } = requireC('../lib/bridge.cjs');
const { loadConfigFromObject } = requireC('../lib/config.cjs');

const fail = (msg) => { console.error(`AUTH FAIL: ${msg}`); process.exitCode = 1; };

const stub = spawn(process.execPath, [path.join(HERE, 'fixtures', 'hrana-auth-stub.cjs'), '0'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stubOut = '';
let url = null;
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('stub did not start in time')), 10000);
  stub.stdout.on('data', (d) => {
    stubOut += d;
    const m = /listening (\d+)/.exec(stubOut);
    if (m && !url) {
      url = `http://127.0.0.1:${m[1]}`;
      clearTimeout(timer);
      resolve();
    }
  });
  stub.on('exit', (code) => { if (!url) { clearTimeout(timer); reject(new Error(`stub exited ${code}`)); } });
});

try {
  await ready;

  // 1. Correct token: open + a statement, value exact.
  const cfg = loadConfigFromObject({ mode: 'libsql', server: { url, authToken: 'sekret' } }, { HOME: '/tmp' });
  if (cfg.mode !== 'libsql' || cfg.degraded) fail('libsql config should stay active with an http(s) URL and a token');
  const db = new BridgeDatabase('probe.db', cfg);
  const row = db.prepare('SELECT 1 AS v').get();
  if (!row || row.v !== 1) fail(`statement result not value-exact: ${JSON.stringify(row)}`);
  db.close();

  // 2. Wrong token: construction must throw (open fails), not proceed.
  const bad = loadConfigFromObject({ mode: 'libsql', server: { url, authToken: 'wrong' } }, { HOME: '/tmp' });
  let threw = null;
  try { new BridgeDatabase('probe.db', bad); } catch (err) { threw = err; }
  if (!threw) fail('a wrong token must fail at open');
  else if (!/HTTP 401|unauthorized/i.test(String(threw.message))) fail(`unexpected wrong-token error: ${threw.message}`);

  // 3. No token configured: the loader degrades instead of attempting.
  const none = loadConfigFromObject({ mode: 'libsql', server: { url } }, { HOME: '/tmp' });
  if (none.mode !== 'telemetry' || !none.degraded) fail('libsql without a token must degrade to telemetry');
  if (!/authToken/.test(String(none.degradedReason))) fail(`degradedReason should name the missing token: ${none.degradedReason}`);

  if (!process.exitCode) console.log('AUTH OK: Bearer token sent; wrong/absent token fails loudly; no-token config degrades');
} catch (err) {
  console.error(`AUTH FAIL: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  try { stub.kill('SIGTERM'); } catch { /* gone */ }
}
