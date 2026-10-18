'use strict';
// Pi extension packaging. Declared in package.json under "pi": { "extensions":
// ["./extension.cjs"] }.
//
// What it does on session_start:
//   1. loads the force-sqlite-to-turso config (fail-safe: a bad config never
//      breaks the session);
//   2. installs the in-process Module._load hook, so better-sqlite3 instances
//      required AFTER this point are wrapped by the configured mode
//      (telemetry / sqld / libsql). This is the same hook the NODE_OPTIONS
//      preload uses; an extension cannot control the agent's argv, but it can
//      patch module loading in-process;
//   3. records an extension_installed event and shows the mode in the status
//      line; a degraded (requested-but-inactive) mode is surfaced as a
//      warning notification with the reason.
//
// Tools:
//   sqlite_route_status - config summary + server status + recent events
//   sqlite_route_doctor - the diagnostic view (config, degraded reason,
//                         stores, server reachability)
//
// The TypeBox schema dependency is resolved lazily so this module can be
// imported (and unit-tested) outside pi; createExtension({ Type }) is the
// test seam.

const path = require('path');
const { loadConfig } = require(path.join(__dirname, 'lib', 'config.cjs'));
const { install } = require(path.join(__dirname, 'lib', 'install.cjs'));
const { recordEvent } = require(path.join(__dirname, 'lib', 'route.cjs'));
const server = require(path.join(__dirname, 'lib', 'server.cjs'));
const fs = require('fs');

function recentEvents(cfg, n) {
  try {
    const lines = fs.readFileSync(cfg.logFile, 'utf8').trim().split('\n').slice(-n);
    return lines.filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  } catch {
    return [];
  }
}

function summary(cfg) {
  return {
    mode: cfg.mode,
    requestedMode: cfg.requestedMode,
    degraded: cfg.degraded,
    degradedReason: cfg.degradedReason || null,
    configPath: cfg.configPath,
    stores: cfg.stores,
    logFile: cfg.logFile,
    server: cfg.server ? { url: cfg.server.url, healthUrl: cfg.server.healthUrl, hasToken: !!cfg.server.authToken } : null,
  };
}

function createExtension({ Type }) {
  function schemaString(desc) { return Type.String({ description: desc }); }
  function schemaNumber(desc) { return Type.Number({ description: desc }); }

  return function forceSqliteExtension(pi) {
    pi.on('session_start', async (_event, ctx) => {
      let cfg;
      try {
        cfg = loadConfig(process.env);
      } catch (err) {
        try { ctx && ctx.ui && ctx.ui.notify && ctx.ui.notify(`force-sqlite-to-turso: config load failed (${err && err.message}); staying inert`, 'warning'); } catch { /* no UI */ }
        return;
      }
      const status = summary(cfg);
      if (cfg.mode !== 'off') {
        try {
          const r = install(cfg);
          recordEvent(cfg, { op: 'extension_installed', mode: cfg.mode, installed: r.installed, already: !!r.already, cwd: ctx && ctx.cwd });
        } catch (err) {
          recordEvent(cfg, { op: 'extension_install_failed', reason: String((err && err.message) || err) });
        }
      } else {
        recordEvent(cfg, { op: 'extension_installed', mode: 'off', installed: false });
      }
      try {
        if (ctx && ctx.hasUI && ctx.ui && typeof ctx.ui.setStatus === 'function') {
          const label = cfg.mode === 'off'
            ? 'force-sqlite: off'
            : `force-sqlite: ${cfg.mode}${cfg.degraded ? ' (degraded)' : ''}`;
          ctx.ui.setStatus('force-sqlite-to-turso', label);
        }
        if (cfg.degraded && ctx && ctx.ui && typeof ctx.ui.notify === 'function') {
          ctx.ui.notify(`force-sqlite-to-turso: requested ${cfg.requestedMode} is inactive - ${cfg.degradedReason}`, 'warning');
        }
      } catch { /* UI must never break the session */ }
      void status;
    });

    pi.registerTool({
      name: 'sqlite_route_status',
      label: 'SQLite route status',
      description: 'Show the force-sqlite-to-turso configuration, single-writer server status, and the most recent routing/telemetry events.',
      promptSnippet: 'Inspect SQLite routing mode, server state, and recent events',
      promptGuidelines: [
        'Use sqlite_route_status when asked whether agent SQLite traffic is being routed, measured, or degraded.',
      ],
      parameters: Type.Object({
        events: Type.Optional(schemaNumber('Number of recent events to include (default 8)')),
      }),
      async execute(_toolCallId, params) {
        let cfg;
        try {
          cfg = loadConfig(process.env);
        } catch (err) {
          return { content: [{ type: 'text', text: `config load failed: ${err && err.message}` }], details: { ok: false } };
        }
        const st = server.status(cfg);
        const health = st.state === 'running' ? await server.health(cfg) : { ok: false, detail: st.state };
        const out = {
          config: summary(cfg),
          server: { ...st, health },
          events: recentEvents(cfg, Number(params && params.events) > 0 ? Number(params.events) : 8),
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: { ok: true, mode: cfg.mode, degraded: cfg.degraded } };
      },
    });

    pi.registerTool({
      name: 'sqlite_route_doctor',
      label: 'SQLite route doctor',
      description: 'Diagnose the force-sqlite-to-turso setup: config resolution, requested vs active mode, per-store routes, server command and reachability.',
      promptSnippet: 'Diagnose SQLite routing configuration and server reachability',
      promptGuidelines: [
        'Use sqlite_route_doctor when routing seems inactive or an agent reports SQLITE_BUSY under parallel sessions.',
      ],
      parameters: Type.Object({}),
      async execute() {
        let cfg;
        try {
          cfg = loadConfig(process.env);
        } catch (err) {
          return { content: [{ type: 'text', text: `config load failed: ${err && err.message}` }], details: { ok: false } };
        }
        const st = server.status(cfg);
        const health = st.state === 'running' ? await server.health(cfg) : { ok: false, detail: st.state };
        const rows = [
          ['config', cfg.configPath ? `read ${cfg.configPath}` : 'absent (defaults)', true],
          ['mode', cfg.degraded ? `${cfg.mode} (requested ${cfg.requestedMode})` : cfg.mode, !cfg.degraded],
          ['degraded reason', cfg.degradedReason || '(none)', !cfg.degraded],
          ['stores', cfg.stores.length ? cfg.stores.map((s) => `${s.match} -> ${s.route}`).join(', ') : '(none configured)', true],
          ['server command', cfg.server && cfg.server.command ? `${cfg.server.command} ${(cfg.server.args || []).join(' ')}`.trim() : '(none)', !!cfg.server],
          ['server state', `${st.state}${st.pid ? ` pid=${st.pid}` : ''}`, st.state !== 'unconfigured'],
          ['server health', health.ok ? 'ok' : String(health.detail), health.ok || cfg.mode === 'telemetry' || cfg.mode === 'off'],
        ];
        const text = rows.map(([name, detail, ok]) => `${ok ? 'ok  ' : 'warn'}  ${name.padEnd(16)} ${detail}`).join('\n');
        return { content: [{ type: 'text', text }], details: { ok: rows.every((r) => r[2]), mode: cfg.mode } };
      },
    });
  };
}

let Type;
try {
  // Resolve the schema library lazily: present inside pi, absent in a bare
  // checkout (where the unit test injects a fake via createExtension).
  ({ Type } = require('typebox'));
} catch {
  Type = null;
}

const extension = Type ? createExtension({ Type }) : null;

module.exports = extension;
module.exports.default = extension;
module.exports.createExtension = createExtension;
