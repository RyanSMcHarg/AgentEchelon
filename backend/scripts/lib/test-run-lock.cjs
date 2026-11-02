/**
 * A machine-wide, single-holder lock for heavy test runs.
 *
 * Why this exists: the backend suite runs as 4 Jest shards. Each shard is a Jest process with
 * `maxWorkers: 4` and `cache: false` (see backend/jest.config.js), so every worker holds a full
 * in-memory TypeScript program and recompiles from scratch. One shard is a reasonable load. Four
 * shards started at once is 16 such workers plus 4 parent processes, and it has hard-locked the
 * development machine - not slowed it, locked it, losing the session's uncommitted work.
 *
 * The jest config already documents the same hazard for worker count and caps it. This is the
 * outer half of that guardrail: the config bounds ONE run, and the lock bounds how many runs
 * exist at a time.
 *
 * The lock is a file, not an advisory flag. `open(..., 'wx')` is an atomic create-or-fail, so two
 * runners racing (for example, four parallel tool calls issued in a single message) cannot both
 * believe they hold it. The loser refuses to start rather than queueing, because a queued run is
 * indistinguishable from a hung one when you come back to read the output.
 *
 * Staleness: a holder that was killed - by a reboot, a harness timeout, Ctrl-C that outran the
 * signal handler - leaves the file behind. A lock whose recorded holder is no longer running is
 * reclaimed rather than honoured, so a crash never requires manual cleanup. The holder is the pid AND
 * the identity recorded beside it (`holderIsLive`), because a pid the operating system has handed to
 * another process is alive and is not the holder. That is exactly the
 * case this was written for, so it must not be the case that jams it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Repo root, from this file's location: backend/scripts/lib -> repo root. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * The directory every checkout of this repository shares: the main checkout's `.git`.
 *
 * ONE LOCK PER MACHINE, NOT PER CHECKOUT. The lock lived at each checkout's root, so a run in a git
 * worktree and a run in the main checkout (or in another worktree) could not see each other, ran at
 * once, and exhausted memory - measured 2026-10-08/09, when two worktrees' Jest runs overlapped and
 * the system killed both. A worktree's `.git` is a FILE naming its own git directory, whose
 * `commondir` names the shared one; the main checkout's `.git` is that directory itself.
 *
 * Null outside a git checkout (a source tarball), where the repo root serves as before.
 */
function sharedGitDir(root) {
  const dotGit = path.join(root, '.git');
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
  if (!pointer) return null;
  const ownGitDir = path.resolve(root, pointer[1]);
  try {
    return path.resolve(ownGitDir, fs.readFileSync(path.join(ownGitDir, 'commondir'), 'utf8').trim());
  } catch {
    return ownGitDir;
  }
}

/** Inside the shared git directory, so every checkout on the machine contends for the same file. */
const LOCK_PATH = path.join(sharedGitDir(REPO_ROOT) ?? REPO_ROOT, 'ae-test-run.lock');

/**
 * Is a process still running? On both Windows and POSIX, signal 0 performs the permission and
 * existence checks without delivering anything. EPERM means it exists but belongs to someone
 * else - which still counts as alive, so we do not steal its lock.
 *
 * ALIVE IS NOT ENOUGH. A pid names whichever process holds it now, and an operating system reuses
 * them: on Windows a lock left by a killed run named a pid that `svchost` took over, EPERM answered
 * "alive" forever, and no run could start until the file was deleted by hand. So the lock also records
 * the holder's identity (`processIdentity`: its executable name and the time the operating system
 * started it), and a holder is live only while the pid still names that process (`holderIsLive`).
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * The identity of the process a pid names now: `{ name, started }`, where `started` is the operating
 * system's own record of when that process began, so it is the same string each time it is asked for
 * the same process and a different one for any process that reuses the pid. `null` when no process
 * holds the pid; `undefined` when this platform cannot say (the caller then decides by the pid alone).
 */
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const { execFileSync } = require('child_process');
  try {
    if (process.platform === 'linux') {
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      } catch {
        return null;
      }
      // `pid (comm) state ...`: comm may hold spaces and parentheses, so split after the LAST ')'.
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const fields = stat.slice(close + 2).split(' ');
      // starttime is field 22 of the line, the 20th after pid and comm.
      return { name, started: fields[19] };
    }
    if (process.platform === 'win32') {
      // CIM answers for every process, another user's included, where Get-Process withholds StartTime.
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.Name + '|' + $p.CreationDate.ToUniversalTime().ToString('o') }`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true }).trim();
      if (!out) return null;
      const bar = out.indexOf('|');
      if (bar < 0) return undefined;
      return { name: out.slice(0, bar), started: out.slice(bar + 1) };
    }
    const out = execFileSync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000,
    }).trim();
    if (!out) return null;
    // lstart is a fixed five-field date (`Mon Oct 19 10:00:00 2026`), then the command name.
    const parts = out.split(/\s+/);
    return { name: parts.slice(5).join(' '), started: parts.slice(0, 5).join(' ') };
  } catch (err) {
    // `ps -p` exits 1 for a pid nothing holds; anything else (no powershell, a timeout) cannot say.
    if (process.platform !== 'win32' && err && err.status === 1) return null;
    return undefined;
  }
}

/** True for a node executable name: `node`, `node.exe`, `nodejs`, with or without a directory. */
function isNodeName(name) {
  const base = String(name || '').trim().split(/[\\/]/).pop();
  return /^node(js)?(\.exe)?$/i.test(base);
}

/**
 * Whether the holder a lock records is still the process that wrote it. `probe` is injectable for the
 * tests (`alive`, `identityOf`); the default asks the operating system.
 *
 *  - The pid is free: not live.
 *  - The lock records an identity and the pid now names a process with another one: the pid was
 *    reused, so not live.
 *  - The lock records no identity (one written before identities were recorded, or on a platform that
 *    could not say): live only while the pid names a node process, since every holder is one.
 *  - The platform cannot say who holds the pid now (`undefined`): the pid alone decides.
 */
function holderIsLive(held, probe = {}) {
  const alive = probe.alive || pidAlive;
  const identityOf = probe.identityOf || processIdentity;
  if (!held || !alive(held.pid)) return false;
  const now = identityOf(held.pid);
  if (now === undefined) return true;
  if (now === null) return false;
  const recorded = held.process;
  if (recorded && typeof recorded.started === 'string' && typeof recorded.name === 'string') {
    return now.started === recorded.started && now.name === recorded.name;
  }
  return isNodeName(now.name);
}

/** Read the current holder, or null if the lock is free or its holder is gone. `probe` as `holderIsLive`. */
function readLock(probe) {
  let raw;
  try {
    raw = fs.readFileSync(LOCK_PATH, 'utf8');
  } catch {
    return null; // no lock file at all
  }
  let held;
  try {
    held = JSON.parse(raw);
  } catch {
    // A truncated or garbled lock file cannot identify a holder, so it cannot be honoured.
    return null;
  }
  if (!holderIsLive(held, probe)) return null;
  return held;
}

/**
 * Take the lock, or return null if someone else holds it. Never blocks and never waits: the
 * caller decides what to tell the user.
 */
function acquire(label) {
  const record = {
    pid: process.pid,
    label: label || 'test run',
    startedAt: new Date().toISOString(),
    host: os.hostname(),
    // Who holds the pid, so a pid the operating system later hands to another process is not taken for
    // this run (`holderIsLive`). Absent where the platform cannot say.
    process: processIdentity(process.pid) || undefined,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(LOCK_PATH, 'wx'); // atomic: create, or fail if it exists
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readLock();
      if (held) return null; // genuinely held by a live process
      // Stale - the holder died. Clear it and try once more. If a second runner clears it at the
      // same instant, one of us wins the 'wx' above and the other sees EEXIST with a live holder.
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch { /* another runner already cleared it */ }
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify(record, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }
  return null;
}

/** Release the lock, but only if we are the holder - never delete someone else's. */
function release() {
  const held = (() => {
    try {
      return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    } catch {
      return null;
    }
  })();
  if (held && held.pid !== process.pid) return;
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch { /* already gone */ }
}

/**
 * Release on every way this process can end. `exit` covers the normal paths; the signals do not
 * fire `exit` on their own, so each is re-raised after cleanup to preserve the exit status a
 * caller would otherwise see.
 */
function releaseOnExit() {
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(sig, () => {
      release();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

/** How long the current holder has been running, in whole minutes. */
function heldForMinutes(held) {
  const started = Date.parse(held.startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.round((Date.now() - started) / 60000));
}

module.exports = {
  LOCK_PATH, REPO_ROOT, sharedGitDir, acquire, release, releaseOnExit, readLock, heldForMinutes, holderIsLive, processIdentity,
};
