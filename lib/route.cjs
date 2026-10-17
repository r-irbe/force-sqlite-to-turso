'use strict';
// Per-store routing decisions (phase 3). The sync bridge that performs the
// actual driver swap is a later phase; until it lands, sqld mode decides and
// RECORDS routing per store - 'pending-sync-bridge' when the server is
// healthy, 'telemetry-fallback' when it is not. Nothing here changes database
// behavior or can crash a call.

const fs = require('fs');
const path = require('path');

function matchingStore(cfg, dbPath) {
  if (!cfg || !Array.isArray(cfg.stores) || dbPath == null) return null;
  const p = String(dbPath);
  return cfg.stores.find((s) => s && typeof s.match === 'string' && p.endsWith(s.match)) || null;
}

function decide(cfg, dbPath, serverHealthy) {
  const store = matchingStore(cfg, dbPath);
  if (!store) return { routed: false, reason: 'no-store-match' };
  return {
    routed: !!serverHealthy,
    store: store.match,
    decision: serverHealthy ? 'pending-sync-bridge' : 'telemetry-fallback',
    reason: serverHealthy ? 'server healthy; driver swap awaits the sync bridge' : 'server unhealthy',
  };
}

function recordEvent(cfg, event) {
  try {
    if (!cfg || !cfg.logFile) return;
    fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
    const line = { ts: new Date().toISOString(), pid: process.pid, ...event };
    fs.appendFileSync(cfg.logFile, `${JSON.stringify(line)}\n`);
  } catch {
    // event logging must never break a database call
  }
}

module.exports = { matchingStore, decide, recordEvent };
