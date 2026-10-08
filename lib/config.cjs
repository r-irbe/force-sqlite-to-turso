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
  // Phases 3 and 4 are not implemented yet; degrade to telemetry rather
  // than risk a crash inside an agent, and record why in the log.
  let degraded = false;
  if (mode === 'sqld' || mode === 'libsql') {
    mode = 'telemetry';
    degraded = true;
  }
  const stores = Array.isArray(cfg.stores)
    ? cfg.stores
        .filter((s) => s && typeof s === 'object' && typeof s.match === 'string')
        .map((s) => ({
          match: s.match,
          redactPath: s.redactPath !== false,
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
