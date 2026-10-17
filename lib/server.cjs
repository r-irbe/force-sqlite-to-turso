'use strict';
// Server lifecycle for sqld-mode: start/stop/status/health of the single-writer
// libSQL server the shim's phase-3 routing will target. The server is ANY
// process implementing the Hrana v2 JSON endpoint (POST /v2/pipeline): a real
// sqld binary, or the loomdb data plane (the reference implementation on this
// machine). Nothing here ever throws: a broken server, a missing binary, or a
// bad PID file degrades to a status report - never an agent crash.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HEALTH_TIMEOUT_MS = 2000;

function pidPath(cfg) {
  return path.join(cfg.stateDir, 'server.pid');
}

function readPid(cfg) {
  try {
    const pid = Number(fs.readFileSync(pidPath(cfg), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health(cfg) {
  const url = cfg.server && cfg.server.healthUrl;
  if (!url) return { ok: false, detail: 'no server.healthUrl configured' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const text = await res.text();
      const ok = res.ok && /"ok"|: ?true|ready|healthy/i.test(text);
      return { ok, status: res.status, detail: text.slice(0, 120) };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, detail: String((err && err.message) || err) };
  }
}

function status(cfg) {
  const configured = !!(cfg.server && cfg.server.command);
  const pid = readPid(cfg);
  const alive = processAlive(pid);
  return {
    configured,
    pid: alive ? pid : null,
    stalePidFile: !!pid && !alive,
    state: !configured ? 'unconfigured' : alive ? 'running' : 'stopped',
    command: cfg.server ? cfg.server.command : null,
    healthUrl: cfg.server ? cfg.server.healthUrl || null : null,
  };
}

async function waitHealthy(cfg, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    const h = await health(cfg);
    if (h.ok) return h;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, detail: 'health timeout' };
}

async function start(cfg) {
  if (!cfg.server || !cfg.server.command) return { ok: false, detail: 'no server.command configured' };
  const current = status(cfg);
  if (current.state === 'running') {
    const h = await health(cfg);
    return { ok: h.ok, state: 'already-running', pid: current.pid, detail: h.detail };
  }
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  try {
    const child = spawn(cfg.server.command, cfg.server.args || [], {
      cwd: cfg.server.cwd || undefined,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    fs.writeFileSync(pidPath(cfg), String(child.pid));
    const h = await waitHealthy(cfg, cfg.server.startTimeoutMs);
    // A server that self-daemonizes makes the launcher's pid meaningless:
    // detect it (spawned pid gone, endpoint healthy) instead of pretending to
    // manage it. Server commands must run in the foreground.
    if (h.ok && !processAlive(child.pid)) {
      return {
        ok: true,
        state: 'self-daemonized',
        pid: child.pid,
        detail: h.detail,
        warning: 'server daemonized itself; the launcher cannot stop or restart it - run the server in the foreground',
      };
    }
    return { ok: h.ok, state: 'started', pid: child.pid, detail: h.detail };
  } catch (err) {
    return { ok: false, state: 'spawn-failed', detail: String((err && err.message) || err) };
  }
}

async function stop(cfg, { timeoutMs = 5000 } = {}) {
  const pid = readPid(cfg);
  if (!pid || !processAlive(pid)) {
    try { fs.unlinkSync(pidPath(cfg)); } catch { /* absent */ }
    return { ok: true, state: 'already-stopped' };
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* raced */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (processAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ }
  }
  try { fs.unlinkSync(pidPath(cfg)); } catch { /* absent */ }
  return { ok: !processAlive(pid), state: 'stopped' };
}

module.exports = { status, start, stop, health, readPid, pidPath };
