'use strict';
// The better-sqlite3 wrapper. Phase 2 (telemetry) is implemented: it counts
// and times operations per store without changing behavior or logging SQL
// text. Phases 3 (sqld single-writer) and 4 (libsql driver swap) degrade to
// telemetry here; the config loader marks them degraded.

'use strict';
const fs = require('fs');
const path = require('path');
const { decide, recordEvent } = require('./route.cjs');

function routeTarget(cfg, dbPath) {
  if (!cfg || !Array.isArray(cfg.stores) || dbPath == null) return null;
  const p = String(dbPath);
  return cfg.stores.find((s) => s && s.route === 'sqld' && typeof s.match === 'string' && p.endsWith(s.match)) || null;
}

// Phase 3 (sqld): the launcher and per-store routing DECISIONS are live; the
// driver swap itself awaits the sync bridge. One async health probe per
// process decides the routing events; database behavior is unchanged.
let sqldProbed = false;
function probeSqldOnce(cfg, dbPath) {
  if (sqldProbed) return;
  sqldProbed = true;
  try {
    if (cfg.mode !== 'sqld' || !cfg.server) return;
    recordEvent(cfg, { op: 'sqld_mode_active', server: cfg.server.url || cfg.server.healthUrl, decision: 'probing' });
    require('./server.cjs').health(cfg).then((h) => {
      const d = decide(cfg, dbPath, h.ok);
      recordEvent(cfg, { op: 'sqld_routing', store: d.store || null, decision: d.decision, reason: d.reason, serverHealthy: h.ok });
      for (const store of cfg.stores || []) {
        if (!d.store || store.match !== d.store) {
          recordEvent(cfg, { op: 'sqld_routing', store: store.match, decision: h.ok ? 'pending-sync-bridge' : 'telemetry-fallback', reason: 'configured store' });
        }
      }
    }).catch(() => {
      recordEvent(cfg, { op: 'sqld_routing', decision: 'telemetry-fallback', reason: 'health probe failed' });
    });
  } catch {
    // routing inspection must never break a database call
  }
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

function logOp(cfg, op, dbPath, ms, extra) {
  try {
    let outPath = dbPath == null ? '(unknown)' : String(dbPath);
    let redact = cfg.logFile ? true : true; // default: basename only
    if (cfg.stores && cfg.stores.length) {
      const hit = cfg.stores.find((s) => outPath.endsWith(s.match));
      if (hit) redact = hit.redactPath;
    }
    if (redact) outPath = path.basename(outPath);
    const line = { ts: new Date().toISOString(), pid: process.pid, op, db: outPath, ms };
    if (extra) Object.assign(line, extra);
    fs.appendFileSync(cfg.logFile, JSON.stringify(line) + '\n');
  } catch {
    // logging must never break a database call
  }
}

function matchesMode(cfg, mode) {
  return cfg.mode === mode;
}

// wrapDatabaseClass(Database, cfg) -> class
// Returns Database unchanged when mode is "off". Telemetry mode returns a
// subclass whose prepare/exec/pragma calls are counted and timed; prepared
// statements get the same treatment on run/get/all/iterate.
function wrapDatabaseClass(Database, cfg) {
  if (!cfg || cfg.mode === 'off') return Database;
  if (cfg.degraded) {
    logOp({ ...cfg, logFile: cfg.logFile }, 'mode_degraded', `requested=${cfg.requestedMode}`, 0);
  }

  const shouldLogSql = cfg.logSqlText === true;

  class ForceSqliteToTurso extends Database {
    constructor(...args) {
      // Routed stores get the sync bridge (synchronous better-sqlite3 calls
      // over the async Hrana protocol). Construction failures - server down,
      // worker broken, timeout - fall back to the native driver for THIS
      // store, so an agent never crashes at open time.
      try {
        const target = routeTarget(cfg, args[0]);
        if (cfg.mode === 'sqld' && cfg.server && target) {
          try {
            const { BridgeDatabase } = require('./bridge.cjs');
            const bridged = new BridgeDatabase(args[0], cfg);
            recordEvent(cfg, { op: 'sqld_routed', store: target.match, driver: 'sync-bridge', url: cfg.server.url });
            return bridged;
          } catch (err) {
            recordEvent(cfg, { op: 'route_fallback_to_sqlite', store: target.match, reason: String((err && err.message) || err) });
          }
        }
      } catch {
        // routing inspection must never break construction
      }
      super(...args);
      try { probeSqldOnce(cfg, args[0]); } catch { /* never break construction */ }
      this.__fst_path = typeof args[0] === 'string' ? args[0] : '(nonstring)';
    }
    prepare(...a) {
      const t0 = nowMs();
      const stmt = super.prepare(...a);
      logOp(cfg, 'prepare', this.__fst_path, nowMs() - t0, shouldLogSql ? { sql: a[0] } : undefined);
      return wrapStatement(stmt, cfg, this.__fst_path);
    }
    exec(...a) {
      const t0 = nowMs();
      const r = super.exec(...a);
      logOp(cfg, 'exec', this.__fst_path, nowMs() - t0, shouldLogSql ? { sql: a[0] } : undefined);
      return r;
    }
    pragma(...a) {
      const t0 = nowMs();
      const r = super.pragma(...a);
      logOp(cfg, 'pragma', this.__fst_path, nowMs() - t0, shouldLogSql ? { sql: a[0] } : undefined);
      return r;
    }
    transaction(fn) {
      const tx = super.transaction(fn);
      return (...txArgs) => {
        const t0 = nowMs();
        try {
          return tx(...txArgs);
        } finally {
          logOp(cfg, 'transaction', this.__fst_path, nowMs() - t0);
        }
      };
    }
  }

  function wrapStatement(stmt, cfg2, dbPath) {
    const wrapped = Object.create(stmt);
    for (const m of ['run', 'get', 'all', 'iterate']) {
      if (typeof stmt[m] !== 'function') continue;
      wrapped[m] = (...a) => {
        const t0 = nowMs();
        try {
          return stmt[m](...a);
        } finally {
          logOp(cfg2, `stmt.${m}`, dbPath, nowMs() - t0);
        }
      };
    }
    return wrapped;
  }

  return ForceSqliteToTurso;
}

module.exports = { wrapDatabaseClass, logOp };
