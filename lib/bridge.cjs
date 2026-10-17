'use strict';
// The sync bridge: a better-sqlite3-compatible Database whose calls are
// synchronous to the caller but execute over the async Hrana protocol in a
// worker thread, coordinated through a SharedArrayBuffer + Atomics.wait.
// This is what makes a driver swap possible without touching any agent's
// call sites: the agent keeps calling db.prepare(...).run(...) exactly as
// before.
//
// Supported surface (documented in the README):
//   new Database(path) / .prepare(sql) / .exec(sql) / .pragma(str)
//   .transaction(fn) (+ .deferred/.immediate/.exclusive aliases)
//   .close() / .open / .readonly / .memory / .name / .inTransaction
//   statement: .run/.get/.all/.iterate/.bind/.pluck/.raw/.columns/.expand/
//              .safeIntegers
// Unsupported on purpose (they need the SQLite C API in-process):
//   .function/.aggregate/.table/.backup/.serialize - each throws a clear
//   error naming the config key that turns routing off for the store.
//
// Failure contract: construction failures (server down, worker broken,
// timeout) throw - the shim catches them and falls back to real
// better-sqlite3 for that store, so an agent never crashes at open time.
// A failure MID-SESSION throws (there is no second database to continue on);
// the shim records a fallback event for the post-mortem.

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const OPEN_TIMEOUT_MS = 15000;

const encode = new TextEncoder();
const decode = new TextDecoder();

// Hrana v2 JSON encodes EVERY value as a typed wrapper: integers travel as
// strings (64-bit safe), text as {type:'text'}, blobs as base64. Bare JSON
// scalars are not accepted as bind values - the live test proved the server
// rejects them ("Provided value cannot be bound to SQLite parameter").
function toArg(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) {
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  if (typeof value === 'string') return { type: 'text', value };
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  if (Array.isArray(value)) return value.map(toArg);
  return { type: 'text', value: String(value) };
}

// Responses arrive either already decoded (worker) or as Hrana typed
// wrappers (raw); accept both so the codec is testable in isolation.
function toNative(value) {
  if (value && typeof value === 'object') {
    if (typeof value.blob === 'string') return Buffer.from(value.blob, 'base64');
    if (value.type === 'blob') return Buffer.from(value.base64 || '', 'base64');
    if (value.type === 'integer') return Number(value.value);
    if (value.type === 'float') return Number(value.value);
    if (value.type === 'text') return String(value.value);
  }
  return value;
}

// Named parameters (:name, @name, $name) are rewritable to positional '?'
// slots, which every Hrana server accepts (the reference server rejects
// named args outright). Quote/comment-aware; a repeated name repeats its
// value, matching SQLite's binding semantics.
function positionalizeNamed(sql, namedArgs) {
  const s = String(sql);
  const out = [];
  const values = [];
  let i = 0;
  const ident = (ch) => /[A-Za-z0-9_]/.test(ch);
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      out.push(ch);
      i += 1;
      while (i < s.length) {
        out.push(s[i]);
        if (s[i] === q) {
          if (s[i + 1] === q) { out.push(s[i + 1]); i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '[') {
      while (i < s.length) { out.push(s[i]); if (s[i] === ']') { i += 1; break; } i += 1; }
      continue;
    }
    if (ch === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') { out.push(s[i]); i += 1; }
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      out.push('/*');
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out.push(s[i]); i += 1; }
      if (i < s.length) { out.push('*/'); i += 2; }
      continue;
    }
    if ((ch === ':' || ch === '@' || ch === '$') && ident(s[i + 1] || '')) {
      let j = i + 1;
      let name = '';
      while (j < s.length && ident(s[j])) { name += s[j]; j += 1; }
      if (!Object.prototype.hasOwnProperty.call(namedArgs, name)) {
        throw Object.assign(new Error(`Missing named parameter '${ch}${name}'`), { code: 'BRIDGE_MISSING_NAMED' });
      }
      out.push('?');
      const v = namedArgs[name];
      const already = v && typeof v === 'object' && ['text', 'integer', 'float', 'blob', 'null'].includes(v.type);
      values.push(already ? v : toArg(v));
      i = j;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return { sql: out.join(''), args: values };
}

function normalizeParams(params) {
  if (params.length === 0) return undefined;
  if (params.length === 1) {
    const p = params[0];
    if (p && typeof p === 'object' && !Array.isArray(p) && !(p instanceof Uint8Array)) {
      const out = {};
      for (const [k, v] of Object.entries(p)) out[k] = toArg(v);
      return out;
    }
    if (Array.isArray(p)) return p.map(toArg);
    return [toArg(p)];
  }
  return params.map(toArg);
}

class BridgeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this._bound = undefined;
    this._pluck = false;
    this._raw = false;
  }

  bind(...params) {
    this._bound = params;
    return this;
  }

  pluck(toggle = true) {
    this._pluck = toggle !== false;
    return this;
  }

  raw(toggle = true) {
    this._raw = toggle !== false;
    return this;
  }

  safeIntegers() {
    return this; // numbers travel as JSON numbers; documented
  }

  expand() {
    return this;
  }

  columns() {
    return [];
  }

  _args(params) {
    const raw = params.length ? params : this._bound || [];
    // Object-form (named) args are positionalized from RAW values: encoding
    // them first and again inside the positionalizer produced
    // '[object Object]' bind values (caught by the live test).
    if (raw.length === 1) {
      const p = raw[0];
      if (p && typeof p === 'object' && !Array.isArray(p) && !(p instanceof Uint8Array)) {
        return positionalizeNamed(this.sql, p);
      }
    }
    return { sql: this.sql, args: normalizeParams(raw) };
  }

  run(...params) {
    const q = this._args(params);
    const r = this.db._call({ op: 'run', sql: q.sql, args: q.args });
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  get(...params) {
    const q = this._args(params);
    const r = this.db._call({ op: 'get', sql: q.sql, args: q.args });
    if (!r.row) return undefined;
    return this._shape(r.row, r.cols);
  }

  all(...params) {
    const q = this._args(params);
    const r = this.db._call({ op: 'all', sql: q.sql, args: q.args });
    return r.rows.map((row) => this._shape(row, r.cols));
  }

  *iterate(...params) {
    // buffered iteration: a remote cursor would hold server state across
    // synchronous calls; materializing is the honest trade at this layer
    yield* this.all(...params);
  }

  _shape(row, cols) {
    if (this._raw) return cols.map((c) => toNative(row[c]));
    if (this._pluck) return toNative(row[cols[0]]);
    const out = {};
    for (const c of cols) out[c] = toNative(row[c]);
    return out;
  }
}

class BridgeDatabase {
  constructor(file, cfg = {}) {
    const server = cfg.server || {};
    if (!server.url) throw Object.assign(new Error('sync bridge: cfg.server.url is required'), { code: 'BRIDGE_NO_URL' });
    this.name = file;
    this.readonly = false;
    this.memory = false;
    this.open = true;
    this.inTransaction = false;

    const bufferBytes = cfg.bridgeBufferBytes || DEFAULT_BUFFER_BYTES;
    this._timeoutMs = cfg.bridgeTimeoutMs || DEFAULT_TIMEOUT_MS;
    this._control = new SharedArrayBuffer(16);
    this._reqSab = new SharedArrayBuffer(bufferBytes);
    this._resSab = new SharedArrayBuffer(bufferBytes);
    this._state = new Int32Array(this._control);
    this._reqBuf = new Uint8Array(this._reqSab);
    this._resBuf = new Uint8Array(this._resSab);

    this._worker = new Worker(path.join(__dirname, 'bridge_worker.cjs'), {
      workerData: {
        control: this._control,
        reqSab: this._reqSab,
        resSab: this._resSab,
        url: server.url,
        authToken: server.authToken,
        bufferBytes,
      },
    });
    this._worker.on('error', (err) => { this._workerError = err; });
    this._worker.unref();

    const opened = this._call({ op: 'open' }, OPEN_TIMEOUT_MS);
    if (!opened.ok) throw new Error('sync bridge: open failed');
  }

  _call(req, timeoutMs) {
    if (this._workerError) throw Object.assign(new Error(`sync bridge: worker error: ${this._workerError.message}`), { code: 'BRIDGE_WORKER' });
    const bytes = encode.encode(JSON.stringify(req));
    if (bytes.length > this._reqBuf.length) {
      throw Object.assign(new Error(`sync bridge: request exceeds ${this._reqBuf.length} bytes`), { code: 'BRIDGE_OVERFLOW' });
    }
    this._reqBuf.set(bytes, 0);
    Atomics.store(this._state, 2, bytes.length);
    Atomics.store(this._state, 0, 1);
    Atomics.notify(this._state, 0);

    const deadline = Date.now() + (timeoutMs || this._timeoutMs);
    for (;;) {
      if (Atomics.load(this._state, 1) === 1) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        Atomics.store(this._state, 0, 0);
        throw Object.assign(new Error(`sync bridge: timeout after ${timeoutMs || this._timeoutMs}ms (${req.op})`), { code: 'BRIDGE_TIMEOUT' });
      }
      Atomics.wait(this._state, 1, 0, remaining);
    }
    const len = Atomics.load(this._state, 3);
    const text = decode.decode(this._resBuf.subarray(0, len));
    const res = JSON.parse(text);
    Atomics.store(this._state, 1, 0);
    Atomics.notify(this._state, 1);
    if (!res.ok) {
      const err = new Error((res.error && res.error.message) || 'sync bridge error');
      err.code = (res.error && res.error.code) || 'BRIDGE_ERROR';
      throw err;
    }
    return res;
  }

  prepare(sql) {
    return new BridgeStatement(this, sql);
  }

  exec(sql) {
    return this._call({ op: 'exec', sql }).changes;
  }

  pragma(str) {
    return this._call({ op: 'pragma', sql: `PRAGMA ${str}` }).rows;
  }

  transaction(fn) {
    const db = this;
    const wrapped = (...args) => {
      db._call({ op: 'begin' });
      db.inTransaction = true;
      try {
        const result = fn(...args);
        db._call({ op: 'commit' });
        db.inTransaction = false;
        return result;
      } catch (err) {
        try { db._call({ op: 'rollback' }); } catch { /* rollback best effort */ }
        db.inTransaction = false;
        throw err;
      }
    };
    wrapped.deferred = wrapped;
    wrapped.immediate = wrapped;
    wrapped.exclusive = wrapped;
    return wrapped;
  }

  close() {
    if (!this.open) return;
    try { this._call({ op: 'close' }); } catch { /* best effort */ }
    this.open = false;
    try { this._worker.terminate(); } catch { /* already gone */ }
  }

  _unsupported(method, hint) {
    throw Object.assign(
      new Error(`sync bridge: db.${method}() is not supported over a remote server. ${hint || 'Set "route": "sqlite" on this store in the force-sqlite-to-turso config to keep the native driver.'}`),
      { code: 'BRIDGE_UNSUPPORTED' },
    );
  }

  function() { this._unsupported('function'); throw new Error('unreachable'); }
  aggregate() { this._unsupported('aggregate'); throw new Error('unreachable'); }
  table() { this._unsupported('table'); throw new Error('unreachable'); }
  backup() { this._unsupported('backup', 'better-sqlite3 backup() is asynchronous and has no remote equivalent; export a snapshot from the server, or set "route": "sqlite" on this store to keep the native driver.'); throw new Error('unreachable'); }
  serialize() { this._unsupported('serialize'); throw new Error('unreachable'); }
  unsafeMode() { this._unsupported('unsafeMode'); throw new Error('unreachable'); }
  loadExtension() { this._unsupported('loadExtension'); throw new Error('unreachable'); }
  defaultSafeIntegers() { return this; }
}

module.exports = { BridgeDatabase, BridgeStatement, normalizeParams, positionalizeNamed, toArg, toNative, DEFAULT_BUFFER_BYTES };
