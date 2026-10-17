#!/usr/bin/env node
'use strict';
// force-sqlite-to-turso CLI: inspect and manage the phase-3 single-writer
// server the shim routes to.
//
//   force-sqlite status   [--config <path>] [--json] [--events N]
//   force-sqlite doctor   [--config <path>]
//   force-sqlite start    [--config <path>]
//   force-sqlite stop     [--config <path>]

const fs = require('fs');
const path = require('path');
const { loadConfigFromObject } = require('../lib/config.cjs');
const { status, start, stop, health } = require('../lib/server.cjs');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function load() {
  const p = flag('--config', process.env.FORCE_SQLITE_TO_TURSO_CONFIG);
  if (p) {
    const abs = path.resolve(p);
    try {
      return loadConfigFromObject(JSON.parse(fs.readFileSync(abs, 'utf8')), process.env, abs);
    } catch (err) {
      console.error(`force-sqlite: unreadable config ${abs}: ${err.message}`);
      process.exit(2);
    }
  }
  // no explicit config: fall through to the default resolution path
  return require('../lib/config.cjs').loadConfig(process.env);
}

async function main() {
  const cmd = process.argv[2];
  const cfg = load();

  if (cmd === 'status') {
    const s = status(cfg);
    const h = s.state === 'running' ? await health(cfg) : { ok: false, detail: s.state };
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ config: { path: cfg.configPath, mode: cfg.mode, degraded: cfg.degraded, stores: cfg.stores, requestedMode: cfg.requestedMode }, server: { ...s, health: h } }, null, 2));
      return;
    }
    console.log(`mode: ${cfg.mode}${cfg.degraded ? ` (degraded from ${cfg.requestedMode})` : ''}`);
    console.log(`config: ${cfg.configPath || '(none; defaults)'}`);
    console.log(`stores: ${cfg.stores.length ? cfg.stores.map((x) => x.match).join(', ') : '(none)'}`);
    console.log(`server: ${s.state}${s.pid ? ` pid=${s.pid}` : ''}${s.healthUrl ? ` health=${s.healthUrl}` : ''}${h.ok ? ' OK' : ` (${h.detail})`}`);
    const n = Number(flag('--events', '5'));
    if (n > 0) {
      try {
        const lines = fs.readFileSync(cfg.logFile, 'utf8').trim().split('\n').slice(-n);
        if (lines.length && lines[0]) {
          console.log('recent events:');
          for (const l of lines) console.log(`  ${l}`);
        }
      } catch {
        // no events yet
      }
    }
    return;
  }

  if (cmd === 'doctor') {
    const s = status(cfg);
    const rows = [];
    rows.push(['config', cfg.configPath ? `read ${cfg.configPath}` : 'absent (defaults)', true]);
    rows.push(['mode', `${cfg.mode}${cfg.degraded ? ` (degraded from ${cfg.requestedMode}: server block missing)` : ''}`, !cfg.degraded]);
    rows.push(['stores', cfg.stores.length ? cfg.stores.map((x) => `${x.match}${x.redactPath ? ' (redacted)' : ''}`).join(', ') : '(none configured)', true]);
    const cmdOk = !!(cfg.server && cfg.server.command);
    rows.push(['server command', cmdOk ? `${cfg.server.command} ${(cfg.server.args || []).join(' ')}`.trim() : 'not configured', cmdOk]);
    const h = s.state === 'running' ? await health(cfg) : { ok: false, detail: s.state };
    rows.push(['server reachable', h.ok ? `yes (${cfg.server.healthUrl})` : `no (${h.detail})`, h.ok]);
    for (const [name, detail, ok] of rows) console.log(`${ok ? 'ok  ' : 'warn'}  ${name.padEnd(16)} ${detail}`);
    process.exit(rows.every((r) => r[2]) ? 0 : 1);
  }

  if (cmd === 'start') {
    const r = await start(cfg);
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'stop') {
    const r = await stop(cfg);
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }

  console.error('usage: force-sqlite status|doctor|start|stop [--config <path>]');
  process.exit(2);
}

main().catch((err) => {
  console.error(`force-sqlite: ${err && err.message}`);
  process.exit(2);
});
