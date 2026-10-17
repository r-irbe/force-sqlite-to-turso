# force-sqlite-to-turso

Rewire any coding agent's SQLite usage onto libSQL/Turso **without modifying
the agent's source**. A `NODE_OPTIONS --require` preload intercepts
`better-sqlite3` at module load; a JSON config decides what happens next.

Named for where it is going (Turso), built for where it must start (your
agent's existing `better-sqlite3` calls). Works for pi today; the same
preload mechanism covers any Node-based agent (claude code, codex, ...).

## Why

Machines running many parallel coding-agent sessions (15+ concurrent
processes observed) share SQLite files. File-level SQLite means every
process fights over one WAL: checkpoints starve and writes fail with
SQLITE_BUSY. The endgame is a **single-writer architecture** -- one libSQL
server (`sqld`) owns the database, every agent process becomes a client --
but you get there in phases that never risk an agent crash.

## Modes (phased, gated by tests)

| Mode | Status | Behavior |
| --- | --- | --- |
| `off` | shipped (default) | Inert. No config, no hook, nothing happens. |
| `telemetry` | shipped | Wrap `better-sqlite3`: count and time operations per store into a JSONL log. SQL text is **never** logged unless you opt in with `logSqlText`. |
| `sqld` | shipped (launcher + routing decisions; the driver swap awaits the sync bridge) | Starts/manages a local single-writer Hrana server (any sqld-compatible command; the loomdb data plane is the reference implementation here), records per-store routing decisions (`pending-sync-bridge` / `telemetry-fallback`), and never changes database behavior. Without a `server` block it degrades to telemetry. |
| `libsql` | later | Full driver swap behind the shim's sync bridge. Until then, same degradation. |

A config error or unsupported mode can never crash an agent: the shim
degrades and logs. The hook itself is wrapped in try/catch and always
falls back to the unmodified module.

## Install

```sh
git clone https://github.com/r-irbe/force-sqlite-to-turso.git
mkdir -p ~/.config/force-sqlite-to-turso
cp config.json.example ~/.config/force-sqlite-to-turso/config.json
# edit the config: mode + stores

# wrap every new node process (add to your shell profile, or wrap agent
# launchers individually):
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $PWD/register.cjs"
```

## Phase 3: sqld mode (launcher + chaos harness)

Configure a server block (run the server in the FOREGROUND - the launcher
daemonizes it and owns the lifecycle; a self-daemonizing command is
detected and reported, because its pid would escape the launcher):

```json
"server": {
  "command": "node",
  "args": ["/path/to/loomdb-plane.cjs", "start", "--config", "/path/to/plane.json"],
  "healthUrl": "http://127.0.0.1:8081/health",
  "url": "http://127.0.0.1:8081"
}
```

```sh
node bin/force-sqlite.cjs status   # mode, stores, server state, recent events
node bin/force-sqlite.cjs doctor   # config + command + reachability
node bin/force-sqlite.cjs start    # spawn detached, health-gated
node bin/force-sqlite.cjs stop     # SIGTERM -> SIGKILL
```

The **chaos harness** proves the single-writer durability claim:
N agent-like clients (`@libsql/client`) write through a real Hrana server,
the server is SIGKILLed mid-run, restarted through the launcher, and every
ACKed commit must survive exactly once.

```sh
npm run test:chaos
```

Measured 2026-10-17: 6 writers x 40 inserts, 240/240 acked, 0 failed,
SIGKILL + restart, rows=240, missing_acked=0, integrity ok.

## Verify

```sh
npm test
```

Nine checks: config expansion, mode degradation, inert-by-default, telemetry
counting with path redaction and SQL-text hiding, identity under `off`, and
a real smoke test -- a child node process with the preload active, loading
the actual vendored `better-sqlite3` and running statements against an
in-memory database through the hook.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `off` | One of `off`, `telemetry`, `sqld`, `libsql`. |
| `logFile` | tmpdir fallback | JSONL telemetry destination; `${VAR}` expanded. |
| `logSqlText` | `false` | Never log SQL statements unless you ask. |
| `stores` | `[]` | Per-store routing/privacy: `{ match, redactPath }`; `match` is a path suffix. |

Machine-specific paths live only in the local (gitignored) config; the
repository ships `config.json.example` with placeholders.

## Roadmap

- `sqld` mode: launcher + per-store routing + chaos harness - SHIPPED
  2026-10-17 (see above). Remaining: the sync bridge.
- Sync bridge: better-sqlite3's synchronous API over async libsql clients
  via a worker + Atomics.wait, so agents keep their exact call sites.
- Compatibility matrix per agent (pi verified; claude code/codex next as
  their runtimes are confirmed on test machines).
- Packaging as a pi extension for pi-native installs.

## License

Apache-2.0
