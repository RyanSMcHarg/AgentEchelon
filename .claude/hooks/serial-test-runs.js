#!/usr/bin/env node
/**
 * PreToolUse hook - one test run at a time, and never the shape that kills the machine.
 *
 * The backend suite runs as 4 Jest shards. Started CONCURRENTLY they hard-lock this machine: each
 * Jest process runs 4 workers holding a full TypeScript program with `cache: false`, so four
 * shards is 16 compiling workers plus their parents. It has cost a session's uncommitted work.
 * The repo has known this for a while - `backend/jest.config.js` caps the worker pool for the same
 * reason, and the tracker records "ONE shard per Bash call" - but knowing it only helped when
 * someone remembered. This refuses instead.
 *
 * It denies four shapes:
 *
 *   1. A raw `--shard=N/M` invocation. There is no correct way to issue these by hand: one at a
 *      time is slow to drive and easy to abandon half-done, and all at once is the crash. The
 *      serial runner exists to do it properly.
 *   2. Two or more test invocations in a single command (`&&`, `;`, `&`, a pipe, a newline). This
 *      is the exact form the crash took.
 *   3. A whole-backend-suite run in one call. It exceeds the 10-minute limit a tool call gets and
 *      is killed mid-run, which surfaces as "Jest worker encountered N child process exceptions" -
 *      a dying pool that reads exactly like a product regression. A previous session lost five
 *      attempts to that misreading.
 *   4. ANY test invocation while a run already holds the lock, including a cheap single-file one.
 *      Serial means serial; the message says who holds it and for how long.
 *
 * A targeted run - `npx jest test/some-file` with the lock free - passes straight through. That
 * is the common case and it stays fast.
 *
 * This is the half that binds a tool call. The half that binds everything else is the lock inside
 * `backend/scripts/lib/test-run-lock.cjs`: the runner takes it atomically for its whole lifetime,
 * so a second runner refuses itself even if it never passed through this hook (a terminal, a
 * different assistant, a `!` command). A hook alone would be advice; a lock alone would not catch
 * the four-at-once form before it spawns. Both.
 *
 * Escape hatch, for the owner and not for an assistant to reach for: a command containing
 * `AE_ALLOW_CONCURRENT_TESTS=1` is allowed through unexamined.
 *
 * Contract (Claude Code PreToolUse hook):
 *   stdin  - JSON: { tool_name, tool_input: { command }, cwd, ... }
 *   stdout - JSON: hookSpecificOutput.permissionDecision "deny", or nothing to allow
 *   exit 0 - always. A throw is swallowed and the call is allowed; a broken hook must not
 *            become a broken session.
 */

const fs = require('fs');
const path = require('path');

const RUNNER = 'cd backend && node scripts/run-test-shards.mjs';

/** Explicit sharding - always wrong by hand. */
const SHARD_RE = /--shard(=|\s)/;

/** Split a command line into the pieces a shell would run as separate commands. */
function segments(command) {
  return command
    .split(/&&|\|\||[;&|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * What does this segment actually RUN? Answered from the leading command word rather than by
 * looking for the word "jest" anywhere in the line, because a substring match cannot tell an
 * invocation from a mention. The looser version of this refused `grep run-test-shards *.js` and
 * would equally have refused `git commit -m "fix jest config"` - and a guard that fires on prose
 * gets switched off, which costs more than it saves.
 *
 * Returns { bin, args } where bin is the tool being invoked, unwrapped through a runner prefix
 * (npx/pnpm/yarn) so `npx jest` and `jest` answer the same.
 */
function invocation(segment) {
  let tokens = segment.split(/\s+/).filter(Boolean);
  // Leading `VAR=value` assignments are environment, not the command.
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  if (tokens.length === 0) return null;

  let bin = tokens[0];
  let args = tokens.slice(1);
  if (/^(npx|pnpm|yarn|bunx)$/.test(bin)) {
    // Skip runner flags such as `npx --yes` before the real binary.
    while (args.length > 0 && args[0].startsWith('-')) args = args.slice(1);
    if (args.length === 0) return null;
    bin = args[0];
    args = args.slice(1);
  }
  // Strip any path so `node_modules/.bin/jest` and `jest` are the same tool.
  const base = bin.split(/[\\/]/).pop().replace(/\.(js|cjs|mjs|cmd|exe)$/, '');
  return { bin: base, args };
}

/**
 * Does this name specific tests to run, or the whole suite? Flags are not filters; a bare
 * positional is. For `npm`, only what follows `--` reaches the test runner - `npm test test/foo`
 * silently drops the argument, so treating it as a filter would let a whole-suite run through.
 */
function hasTestFilter(args, viaNpm) {
  let rest = args;
  if (viaNpm) {
    const dashDash = rest.indexOf('--');
    if (dashDash === -1) return false;
    rest = rest.slice(dashDash + 1);
  }
  return rest.some((token) => !token.startsWith('-'));
}

/**
 * Which tree is this command aimed at? Deliberately answered from the WHOLE command line and the
 * cwd, not from the one segment holding the test invocation: in `cd frontend && npm test` the
 * directory and the invocation are different segments, so a per-segment answer reads the frontend
 * suite as the backend one and refuses it.
 */
function targetTree(command, cwd) {
  const where = `${command}\n${cwd || ''}`;
  return {
    frontend: /\bfrontend\b|-ws\b|-w\s+@ae\//.test(where),
    backend: /\bbackend\b/.test(where),
  };
}

/** What kind of test invocation is this segment, if any? */
function classify(segment, tree) {
  const call = invocation(segment);
  if (!call) return null;
  const { bin, args } = call;

  // The sanctioned serial runner, by either spelling.
  if (bin === 'node' && args.some((a) => a.replace(/\\/g, '/').endsWith('scripts/run-test-shards.mjs'))) {
    return 'runner';
  }
  if (bin === 'npm' && args.includes('test:shards')) return 'runner';

  if (bin === 'playwright' && args.includes('test')) return 'e2e';

  const viaNpm = bin === 'npm';
  let testArgs = args;
  if (viaNpm) {
    // `npm test`, `npm run test`, `npm -w @ae/chat run test`, `npm -ws --if-present run test`.
    const scriptAt = args.findIndex((a) => a === 'test' || a.startsWith('test:'));
    if (scriptAt === -1) return null;
    // A named script other than the bare `test` (e.g. `test:signup`, the Playwright suites) is a
    // real test run: allowed on its own, but it still counts against concurrency and the lock.
    if (args[scriptAt] !== 'test') return 'targeted';
    testArgs = args.slice(scriptAt + 1);
  } else if (bin !== 'jest') {
    return null;
  }

  if (SHARD_RE.test(segment)) return 'shard';
  if (hasTestFilter(testArgs, viaNpm)) return 'targeted';

  // An unfiltered run. Only the backend suite is large enough to blow the call timeout; the
  // frontend workspaces are ~250 tests total and finish well inside it.
  if (tree.frontend && !tree.backend) return 'frontend';
  return 'full';
}

/** The live holder of the test-run lock, or null. Read-only - this hook never takes it. */
function lockHolder(cwd) {
  const roots = [cwd, process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      // The root may be the REPO root or the backend directory itself - sessions in this repo run
      // with cwd=backend, and joining 'backend' onto that yielded backend/backend/... so the module
      // was never found, the holder read as null, and the concurrent-run denial this hook exists
      // for never fired while a sharded run held the live lock.
      const candidates = [
        path.join(root, 'backend', 'scripts', 'lib', 'test-run-lock.cjs'),
        path.join(root, 'scripts', 'lib', 'test-run-lock.cjs'),
      ];
      const mod = candidates.find((c) => fs.existsSync(c));
      if (!mod) continue;
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const lock = require(mod);
      const held = lock.readLock();
      return held ? { ...held, minutes: lock.heldForMinutes(held), lockPath: lock.LOCK_PATH } : null;
    } catch {
      // An unreadable lock module must not block a test run; fall through to "not held".
    }
  }
  return null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const command = String(payload.tool_input?.command || '');
  if (!command) process.exit(0);
  if (command.includes('AE_ALLOW_CONCURRENT_TESTS=1')) process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const tree = targetTree(command, cwd);
  const kinds = segments(command).map((s) => classify(s, tree)).filter(Boolean);
  if (kinds.length === 0) process.exit(0);

  if (kinds.includes('shard')) {
    deny(
      'Refused: `--shard` by hand. Four shards started at once hard-locks this machine (16 '
      + 'ts-jest workers, each holding a full TS program with cache disabled), and one shard per '
      + 'call is slow to drive and easy to abandon half-run.\n\n'
      + `Run the whole suite serially instead, in the BACKGROUND (it exceeds 10 minutes):\n  ${RUNNER}\n\n`
      + 'It holds an exclusive lock, runs shards 1..N one after another, and prints a per-shard '
      + 'and total summary.',
    );
  }

  if (kinds.length > 1) {
    deny(
      `Refused: ${kinds.length} test runs in a single command (${kinds.join(', ')}). Concurrent `
      + 'test runs have hard-locked this machine, and chained ones exceed the 10-minute call '
      + 'limit so the later ones are killed mid-run - which looks like a regression and is not.\n\n'
      + `One test run per call. For the whole backend suite, in the background:\n  ${RUNNER}`,
    );
  }

  const held = lockHolder(cwd);
  if (held) {
    const age = held.minutes === null ? '' : `, ${held.minutes} min ago`;
    deny(
      `Refused: a test run is already in progress - ${held.label} (pid ${held.pid}, started `
      + `${held.startedAt}${age}).\n\nTest runs on this machine are serial. Wait for it to finish `
      + 'and read its summary, then run yours. If that process is gone, the lock is reclaimed '
      + `automatically on the next attempt; the file is ${held.lockPath}.`,
    );
  }

  if (kinds[0] === 'full') {
    deny(
      'Refused: the whole backend suite in one call. It exceeds the 10-minute limit and is killed '
      + 'mid-run, reporting "Jest worker encountered N child process exceptions" - a dying worker '
      + 'pool, not a regression. A previous session lost five attempts to that misreading.\n\n'
      + `Run it sharded and serial, in the BACKGROUND:\n  ${RUNNER}\n\n`
      + 'To check one area quickly, name the tests: `cd backend && npx jest test/<pattern>`.',
    );
  }

  process.exit(0);
}

try {
  main();
} catch {
  // Allow the call. A hook that fails closed on its own bug would be worse than the crash it
  // guards against.
  process.exit(0);
}
