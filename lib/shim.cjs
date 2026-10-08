'use strict';
// The better-sqlite3 wrapper. Phase 2 (telemetry) is implemented: it counts
// and times operations per store without changing behavior or logging SQL
// text. Phases 3 (sqld single-writer) and 4 (libsql driver swap) degrade to
// telemetry here; the config loader marks them degraded.

'use strict';
const fs = require('fs');
const path = require('path');

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
      super(...args);
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
