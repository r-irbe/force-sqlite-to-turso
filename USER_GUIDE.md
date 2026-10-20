# force-sqlite-to-turso User Guide

`force-sqlite-to-turso` is a zero-code-change Node.js preload (`NODE_OPTIONS="--require ..."`) and `pi` extension that intercepts `better-sqlite3` at module load and routes database operations to telemetry logs or a single-writer libSQL/Turso Hrana server.

## 1. Quick Start

```bash
git clone https://github.com/r-irbe/force-sqlite-to-turso.git
cd force-sqlite-to-turso
mkdir -p ~/.config/force-sqlite-to-turso
cp config.json.example ~/.config/force-sqlite-to-turso/config.json
```

Activate the preload shim for any Node.js coding agent (`pi`, Claude Code, Codex):

```bash
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require /path/to/force-sqlite-to-turso/register.cjs"
```

Or use the CLI (`force-sqlite` / `node bin/force-sqlite.cjs`):

```bash
npx force-sqlite status
npx force-sqlite doctor
npx force-sqlite start
npx force-sqlite stop
```

## 2. Operating Modes

Configure `~/.config/force-sqlite-to-turso/config.json` (or point `FORCE_SQLITE_TO_TURSO_CONFIG` to a custom JSON file):

| Mode | Description |
| :--- | :--- |
| `off` | Default. Shim is completely inert and returns the original `better-sqlite3` constructor untouched. |
| `telemetry` | Wraps `better-sqlite3` to record per-operation latency and store counts to a JSONL log (`logFile`). SQL text is redacted unless `logSqlText: true`. |
| `sqld` | Launches/manages a local single-writer Hrana server (`server` block) and routes stores configured with `"route": "sqld"` through the synchronous Worker/Atomics Hrana bridge. |
| `libsql` | Routes opted-in stores to a remote HTTP(S) Hrana v2 pipeline endpoint (such as Turso) using Bearer token authentication (`server.authToken`). |

## 3. Configuration Example

```json
{
  "mode": "sqld",
  "logFile": "~/.local/state/force-sqlite-to-turso/telemetry.jsonl",
  "logSqlText": false,
  "server": {
    "command": "sqld",
    "args": ["--http-listen-addr", "127.0.0.1:8081"],
    "healthUrl": "http://127.0.0.1:8081/health",
    "url": "http://127.0.0.1:8081",
    "authToken": "${TURSO_AUTH_TOKEN}"
  },
  "stores": [
    {
      "match": "sessions.db",
      "route": "sqld",
      "redactPath": true
    }
  ]
}
```

## 4. Synchronous Hrana Bridge

Because `better-sqlite3` callers expect synchronous `db.prepare(sql).run()` / `.get()` / `.all()` semantics, `force-sqlite-to-turso` executes HTTP Hrana pipeline requests inside a dedicated Node.js `worker_threads` worker and synchronizes results over `SharedArrayBuffer` and `Atomics.wait`. If the configuration is invalid or the server is unreachable at startup, the shim degrades gracefully rather than crashing the host agent.

## 5. Verification & Chaos Testing

```bash
npm test              # Unit and preload self-tests + Bearer auth token tests
npm run test:bridge   # Live Hrana bridge compatibility suite
npm run test:chaos    # Multi-writer SIGKILL durability and recovery harness
npm run test:compat   # Driver compatibility matrix
```
