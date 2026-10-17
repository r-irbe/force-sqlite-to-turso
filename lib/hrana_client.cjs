'use strict';
// Minimal Hrana v2 JSON client: enough of the protocol for the sync bridge
// to run statements against any conforming server (sqld, the loomdb data
// plane, a Turso-compatible endpoint) with zero dependencies - global fetch
// is the only transport. Shapes follow the Hrana v2 pipeline: POST
// /v2/pipeline with {baton, requests}; results carry {type:'ok'|'error'}.
//
// Value encoding follows Hrana JSON: integers and reals are numbers, text is
// a string, null is null, blobs travel as {type:'blob', base64}. The bridge
// converts blobs to Buffers on the main thread.

function makeClient({ url, authToken } = {}) {
  if (!url) throw new Error('hrana client: url is required');
  const base = String(url).replace(/\/+$/, '');
  const endpoint = `${base}/v2/pipeline`;
  let baton = null;
  let closed = false;
  let nextSqlId = 1;

  function headers() {
    const h = { 'content-type': 'application/json' };
    if (authToken) h.authorization = `Bearer ${authToken}`;
    return h;
  }

  async function pipeline(requests) {
    if (closed) throw Object.assign(new Error('hrana client: connection closed'), { code: 'BRIDGE_CLOSED' });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ baton, requests }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`hrana: HTTP ${res.status} ${body.slice(0, 200)}`), { code: `HTTP_${res.status}` });
    }
    const data = await res.json();
    baton = data.baton === undefined ? null : data.baton;
    const results = Array.isArray(data.results) ? data.results : [];
    for (const r of results) {
      if (r && r.type === 'error') {
        const msg = (r.error && r.error.message) || 'hrana error';
        const code = (r.error && r.error.code) || 'SQL_ERROR';
        throw Object.assign(new Error(msg), { code });
      }
    }
    return results;
  }

  function execRequest(sql, args) {
    const stmt = { sql };
    if (args && (Array.isArray(args) ? args.length : Object.keys(args).length)) stmt.args = args;
    return { type: 'execute', stmt };
  }

  return {
    async open() {
      await pipeline([execRequest('SELECT 1')]);
      return true;
    },
    async execute(sql, args) {
      const [result] = await pipeline([execRequest(sql, args)]);
      const response = result && result.response;
      const exec = response && response.result;
      return {
        cols: (exec && exec.cols) || [],
        rows: (exec && exec.rows) || [],
        changes: (exec && exec.affected_row_count) || 0,
        lastInsertRowid: exec && exec.last_insert_rowid !== undefined ? Number(exec.last_insert_rowid) : 0,
      };
    },
    async batch(statements) {
      // run sequentially on one baton: order is guaranteed and a failure
      // surfaces at its own statement index
      const out = [];
      for (const s of statements) out.push(await this.execute(s.sql, s.args));
      return out;
    },
    async close() {
      closed = true;
      try {
        await pipeline([{ type: 'close' }]);
      } catch {
        // already gone
      }
    },
    get batonValue() { return baton; },
    get nextSqlIdValue() { return nextSqlId; },
    _advanceSqlId() { nextSqlId += 1; return nextSqlId; },
  };
}

// Quote- and comment-aware statement splitting for exec(): the same rule as
// the server-side bind guard - ';' inside strings, quoted identifiers, or
// comments does not terminate a statement.
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const s = String(sql || '');
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      cur += ch;
      i += 1;
      while (i < s.length) {
        cur += s[i];
        if (s[i] === ch) {
          if (s[i + 1] === ch) { cur += s[i + 1]; i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') { cur += s[i]; i += 1; }
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      cur += '/*';
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { cur += s[i]; i += 1; }
      if (i < s.length) { cur += '*/'; i += 2; }
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

module.exports = { makeClient, splitStatements };
