#!/usr/bin/env node
'use strict';
// Out-of-process Hrana auth stub for test/auth-token.mjs. The sync bridge
// blocks its caller's thread in Atomics.wait, so an in-process HTTP server
// can never answer it (learned the hard way) - the endpoint must live in
// another process or thread.
//
// Usage: node hrana-auth-stub.cjs [port]   (0 = ephemeral; prints the port)
// Auth: requires "Authorization: Bearer sekret"; every other token gets 401.

const http = require('http');

const port = Number(process.argv[2] || 0);
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || null;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (auth !== 'Bearer sekret') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* bad json */ }
    const results = (parsed.requests || []).map((r) => {
      if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
      return {
        type: 'ok',
        response: {
          type: 'execute',
          result: {
            cols: [{ name: 'v' }],
            rows: [[{ type: 'integer', value: '1' }]],
            affected_row_count: 0,
          },
        },
      };
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ baton: null, results }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`listening ${server.address().port}`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
