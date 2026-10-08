'use strict';
// Preload entry: NODE_OPTIONS="--require /path/to/force-sqlite-to-turso/register.cjs"
// Intercepts require("better-sqlite3") (and absolute-path requires of the
// module) in ANY node process -- pi, claude code, or any other agent that
// loads better-sqlite3. Without a config the hook is fully inert.

'use strict';
const Module = require('module');
const os = require('os');
const path = require('path');
const { loadConfig } = require(path.join(__dirname, 'lib', 'config.cjs'));
const { wrapDatabaseClass } = require(path.join(__dirname, 'lib', 'shim.cjs'));

const cfg = loadConfig(process.env);

if (cfg.mode !== 'off') {
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
}
