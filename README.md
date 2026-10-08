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
| `sqld` | next phase | Route targets through a local libsql-server (single writer on 127.0.0.1). Until implemented, degrades to telemetry and records a `mode_degraded` event. |
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

## Verify

```sh
npm test
```

Six checks: config expansion, mode degradation, inert-by-default, telemetry
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

- `sqld` mode: launcher + per-store routing + a chaos harness (N agent-like
  clients, kill -9 the server mid-transaction, zero lost committed writes).
- Sync bridge: better-sqlite3's synchronous API over async libsql clients
  via a worker + Atomics.wait, so agents keep their exact call sites.
- Compatibility matrix per agent (pi verified; claude code/codex next as
  their runtimes are confirmed on test machines).
- Packaging as a pi extension for pi-native installs.

## License

Apache-2.0
