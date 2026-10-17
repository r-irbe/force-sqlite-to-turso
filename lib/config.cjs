'use strict';
// Config loader for force-sqlite-to-turso. Pure logic, no side effects, so
// the self-test can exercise it without touching a real database.
//
// Config resolution order:
//   1. FORCE_SQLITE_TO_TURSO_CONFIG env (absolute path)
//   2. ~/.config/force-sqlite-to-turso/config.json
//   3. absent -> { mode: "off" } (inert; no agent is ever disturbed)
//
// Machine-specific paths live in the local config only; repositories ship
// config.json.example with $HOME-style placeholders.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES = ['off', 'telemetry', 'sqld', 'libsql'];

// expandVars(str, env) -- replaces ${VAR} and $HOME-style references.
// Unknown variables expand to "" (same contract as pi-subagent-compact).
function expandVars(value, env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, brace, bare) => {
    const key = brace || bare;
    if (key === 'HOME') return env.HOME || os.homedir();
    return env[key] !== undefined ? env[key] : '';
  });
}

function expandDeep(value, env) {
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, env));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, env);
    return out;
  }
  return expandVars(value, env);
}

// loadConfigFromObject(raw, env, configPath) -> normalized config.
// Never throws on user input: invalid fields degrade to defaults so a bad
// config can never crash a coding agent at require time.
function loadConfigFromObject(raw, env, configPath) {
  const cfg = expandDeep(raw && typeof raw === 'object' ? raw : {}, env || process.env);
  let mode = cfg.mode;
  if (!MODES.includes(mode)) mode = 'off';
  // Phase 3 (sqld): operational as launcher + per-store routing decisions;
  // the driver swap itself waits for the sync bridge. It needs a server block
  // (command + healthUrl); without one it degrades to telemetry. Phase 4
  // (libsql) always degrades until the bridge lands.
  const rawServer = cfg.server && typeof cfg.server === 'object' ? cfg.server : null;
  const hasCommand = !!(rawServer && typeof rawServer.command === 'string');
  // libsql mode needs no launcher (the endpoint is remote/managed), so a
  // server object with just url+authToken is enough there.
  const server = rawServer && (hasCommand || typeof rawServer.url === 'string')
    ? {
        command: typeof rawServer.command === 'string' ? rawServer.command : null,
        args: Array.isArray(rawServer.args) ? rawServer.args.map(String) : [],
        cwd: typeof rawServer.cwd === 'string' ? rawServer.cwd : undefined,
        healthUrl: typeof rawServer.healthUrl === 'string' ? rawServer.healthUrl : 'http://127.0.0.1:8081/health',
        url: typeof rawServer.url === 'string' ? rawServer.url : 'http://127.0.0.1:8081',
        authToken: typeof rawServer.authToken === 'string' ? rawServer.authToken : undefined,
        startTimeoutMs: Number.isFinite(rawServer.startTimeoutMs) ? rawServer.startTimeoutMs : 15000,
      }
    : null;
  let degraded = false;
  let degradedReason = null;
  if (mode === 'sqld' && !server) {
    mode = 'telemetry';
    degraded = true;
    degradedReason = 'server block missing';
  }
  if (mode === 'libsql') {
    if (!server) {
      mode = 'telemetry';
      degraded = true;
      degradedReason = 'server block missing';
    } else if (!/^https?:/i.test(server.url)) {
      // The bridge speaks Hrana v2 JSON over HTTP(S). libsql:// and wss://
      // URLs are the WebSocket transport, which is not implemented; degrade
      // honestly rather than fail inside an agent.
      mode = 'telemetry';
      degraded = true;
      degradedReason = 'libsql:// (websocket) transport not implemented; use an http(s) Hrana endpoint';
    } else if (!server.authToken) {
      // Remote endpoints require auth; a silent unauthenticated attempt
      // would surface as opaque 401s deep inside an agent.
      mode = 'telemetry';
      degraded = true;
      degradedReason = 'libsql mode requires server.authToken';
    }
  }
  const stores = Array.isArray(cfg.stores)
    ? cfg.stores
        .filter((s) => s && typeof s === 'object' && typeof s.match === 'string')
        .map((s) => ({
          match: s.match,
          redactPath: s.redactPath !== false,
          route: s.route === 'sqld' || s.route === 'libsql' ? s.route : 'sqlite',
        }))
    : [];
  return {
    mode,
    requestedMode: (raw && raw.mode) || 'off',
    degraded,
    configPath: configPath || null,
    logFile: typeof cfg.logFile === 'string' ? cfg.logFile : path.join(os.tmpdir(), 'force-sqlite-to-turso.log'),
    logSqlText: cfg.logSqlText === true, // never log SQL text unless explicitly asked
    stores,
    server,
    degradedReason,
    stateDir: typeof cfg.stateDir === 'string' && cfg.stateDir
      ? cfg.stateDir
      : path.join(env && env.HOME ? env.HOME : os.homedir(), '.local', 'state', 'force-sqlite-to-turso'),
  };
}

function defaultConfigPath(env) {
  const e = env || process.env;
  if (e.FORCE_SQLITE_TO_TURSO_CONFIG) return expandVars(e.FORCE_SQLITE_TO_TURSO_CONFIG, e);
  return path.join(e.HOME || os.homedir(), '.config', 'force-sqlite-to-turso', 'config.json');
}

function loadConfig(env) {
  const p = defaultConfigPath(env);
  if (!fs.existsSync(p)) return loadConfigFromObject({}, env, null);
  try {
    return loadConfigFromObject(JSON.parse(fs.readFileSync(p, 'utf8')), env, p);
  } catch {
    return loadConfigFromObject({}, env, p);
  }
}

module.exports = { MODES, expandVars, expandDeep, loadConfigFromObject, defaultConfigPath, loadConfig };
