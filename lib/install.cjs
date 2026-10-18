'use strict';
// In-process hook installer, shared by the NODE_OPTIONS preload (register.cjs)
// and the pi extension (extension.cjs). Patching Module._load means a LATER
// require('better-sqlite3') is wrapped even in a process that was already
// running when the hook installed - which is what makes extension packaging
// possible without controlling the agent's argv.
//
// Idempotent: a second install() is a no-op. Any hook failure degrades to the
// unmodified module - an agent must never crash because of this package.

const Module = require('module');
const path = require('path');
const { loadConfig } = require(path.join(__dirname, 'config.cjs'));
const { wrapDatabaseClass } = require(path.join(__dirname, 'shim.cjs'));

let installed = false;

function install(cfgArg) {
  const cfg = cfgArg || loadConfig(process.env);
  if (!cfg || cfg.mode === 'off') return { installed: false, mode: 'off', reason: 'mode off' };
  if (installed) return { installed: true, mode: cfg.mode, already: true };

  const origLoad = Module._load;
  Module._load = function forceSqliteToTursoLoad(request, parent, isMain) {
    const resolved = origLoad.apply(this, arguments);
    try {
      const hits =
        request === 'better-sqlite3' ||
        /[\\/]better-sqlite3([\\/]|$)/.test(String(request)) ||
        (resolved && typeof resolved === 'function' && resolved.name === 'Database' && /better-sqlite3/.test(String(resolved)));
      if (hits && resolved && !resolved.__forceSqliteToTurso) {
        const wrapped = wrapDatabaseClass(resolved, cfg);
        wrapped.__forceSqliteToTurso = true;
        return wrapped;
      }
    } catch {
      // any hook failure must degrade to the unmodified module
    }
    return resolved;
  };
  installed = true;
  return { installed: true, mode: cfg.mode };
}

function isInstalled() {
  return installed;
}

module.exports = { install, isInstalled };
