'use strict';
// Preload entry: NODE_OPTIONS="--require /path/to/force-sqlite-to-turso/register.cjs"
// Intercepts require("better-sqlite3") (and absolute-path requires of the
// module) in ANY node process -- pi, claude code, or any other agent that
// loads better-sqlite3. Without a config the hook is fully inert.
//
// The hook itself lives in lib/install.cjs so the pi extension can install
// the SAME implementation in-process (patched Module._load also catches
// requires issued long after the extension's session_start).

'use strict';
const path = require('path');
const { install } = require(path.join(__dirname, 'lib', 'install.cjs'));

install();
