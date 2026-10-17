'use strict';
// The bridge worker: owns the async Hrana client and serves SYNCHRONOUS
// callers on the main thread through a shared buffer + Atomics. One request
// is in flight at a time (a synchronous API is sequential by construction).
//
// Protocol (SharedArrayBuffer, Int32 control [0..3], two byte buffers):
//   control[0]  state: 0 idle, 1 request posted, 2 response posted
//   control[1]  request length (bytes)
//   control[2]  response length (bytes)
//   control[3]  reserved
// The main thread writes UTF-8 JSON into reqBuf, sets state=1 and notifies;
// the worker waits on state==0, executes, writes resBuf, sets state=2 and
// notifies. The main thread reads resBuf and resets state=0. Results travel
// through the shared buffer, never postMessage: the main thread is blocked
// in Atomics.wait, so message events could not be dispatched.
//
// Operations: open, run, get, all, exec, pragma, begin, commit, rollback,
// close. Query results carry column names plus row arrays; blob values are
// tagged {blob: base64} for the main thread to convert into Buffers.

const { parentPort, workerData } = require('worker_threads');
const { makeClient, splitStatements } = require('./hrana_client.cjs');

const { control, reqSab, resSab, url, authToken, bufferBytes } = workerData;
const state = new Int32Array(control);
const reqBuf = new Uint8Array(reqSab);
const resBuf = new Uint8Array(resSab);
const decode = new TextDecoder();
const encode = new TextEncoder();

let client = null;

// Decode the Hrana v2 typed-value wrappers into JS scalars (blobs stay
// tagged for the main thread to convert into Buffers). Integers arrive as
// strings for 64-bit safety; Number() matches better-sqlite3's default.
function taggedValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    if (value.type === 'integer') return Number(value.value);
    if (value.type === 'float') return Number(value.value);
    if (value.type === 'text') return String(value.value);
    if (value.type === 'blob') return { blob: value.base64 !== undefined ? value.base64 : Buffer.from(value.value || []).toString('base64') };
    if (typeof value.blob === 'string') return value;
  }
  return value;
}

function rowsToObjects(cols, rows) {
  const names = (cols || []).map((c) => (typeof c === 'string' ? c : c && c.name));
  return (rows || []).map((row) => {
    const obj = {};
    for (let i = 0; i < names.length; i += 1) obj[names[i]] = taggedValue(row[i]);
    return obj;
  });
}

async function handle(op) {
  switch (op.op) {
    case 'open': {
      client = makeClient({ url, authToken });
      await client.open();
      return { ok: true };
    }
    case 'run': {
      const r = await client.execute(op.sql, op.args);
      return { ok: true, changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    }
    case 'get': {
      const r = await client.execute(op.sql, op.args);
      const rows = rowsToObjects(r.cols, r.rows);
      return { ok: true, row: rows.length ? rows[0] : null, cols: (r.cols || []).map((c) => (typeof c === 'string' ? c : c && c.name)) };
    }
    case 'all': {
      const r = await client.execute(op.sql, op.args);
      return { ok: true, rows: rowsToObjects(r.cols, r.rows), cols: (r.cols || []).map((c) => (typeof c === 'string' ? c : c && c.name)) };
    }
    case 'exec': {
      const statements = splitStatements(op.sql);
      let changes = 0;
      for (const sql of statements) {
        const r = await client.execute(sql);
        changes += r.changes;
      }
      return { ok: true, changes, statements: statements.length };
    }
    case 'pragma': {
      const r = await client.execute(op.sql);
      const rows = rowsToObjects(r.cols, r.rows);
      return { ok: true, rows, changes: r.changes };
    }
    case 'begin':
    case 'commit':
    case 'rollback': {
      const r = await client.execute(op.op.toUpperCase());
      return { ok: true, changes: r.changes };
    }
    case 'close': {
      if (client) await client.close();
      client = null;
      return { ok: true };
    }
    default:
      return { ok: false, error: { message: `bridge: unknown op '${op.op}'`, code: 'BRIDGE_UNKNOWN_OP' } };
  }
}

async function loop() {
  // Handshake (v2, 2026-10-18): control[0] reqFlag (main->worker),
  // control[1] resFlag (worker->main), control[2] reqLen, control[3] resLen.
  // The worker clears reqFlag IMMEDIATELY after reading the request, before
  // executing. The previous single-state protocol deadlocked: the main thread
  // could post the next request (state=1) before the worker observed the
  // reset to 0, after which the worker waited forever for 0 while the main
  // waited for 2 (reproduced as a 60s COMMIT timeout).
  for (;;) {
    Atomics.wait(state, 0, 0);
    const reqLen = Atomics.load(state, 2);
    Atomics.store(state, 0, 0); // consumed: the main thread may post again
    let response;
    try {
      const op = JSON.parse(decode.decode(reqBuf.subarray(0, reqLen)));
      response = await handle(op);
    } catch (err) {
      response = { ok: false, error: { message: String((err && err.message) || err), code: (err && err.code) || 'BRIDGE_ERROR' } };
    }
    let bytes;
    try {
      bytes = encode.encode(JSON.stringify(response));
    } catch (err) {
      bytes = encode.encode(JSON.stringify({ ok: false, error: { message: `bridge: unencodable response: ${err.message}`, code: 'BRIDGE_ENCODE' } }));
    }
    if (bytes.length > bufferBytes) {
      bytes = encode.encode(JSON.stringify({ ok: false, error: { message: `bridge: response exceeds ${bufferBytes} bytes (raise bridgeBufferBytes)`, code: 'BRIDGE_OVERFLOW' } }));
    }
    // The previous response must have been consumed (resFlag back to 0)
    // before this one is published; with the sequential main thread this
    // never blocks, but it is the safety net for a confused caller.
    const waitDeadline = Date.now() + 120000;
    while (Atomics.load(state, 1) !== 0) {
      if (Date.now() > waitDeadline) break;
      Atomics.wait(state, 1, 1, 1000);
    }
    resBuf.set(bytes, 0);
    Atomics.store(state, 3, bytes.length);
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1);
  }
}

parentPort.postMessage({ ready: true });
loop().catch((err) => {
  parentPort.postMessage({ fatal: String((err && err.message) || err) });
});
