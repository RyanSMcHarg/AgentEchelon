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
 * signal handler - leaves the file behind. A lock whose recorded pid is no longer running is
 * reclaimed rather than honoured, so a crash never requires manual cleanup. That is exactly the
 * case this was written for, so it must not be the case that jams it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Repo root, from this file's location: backend/scripts/lib -> repo root. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Gitignored, at the repo root so it is obvious and hand-deletable if it ever needs to be. */
const LOCK_PATH = path.join(REPO_ROOT, '.test-run.lock');

/**
 * Is a process still running? On both Windows and POSIX, signal 0 performs the permission and
 * existence checks without delivering anything. EPERM means it exists but belongs to someone
 * else - which still counts as alive, so we do not steal its lock.
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

/** Read the current holder, or null if the lock is free or its holder is gone. */
function readLock() {
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
  if (!pidAlive(held.pid)) return null;
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

module.exports = { LOCK_PATH, REPO_ROOT, acquire, release, releaseOnExit, readLock, heldForMinutes };
