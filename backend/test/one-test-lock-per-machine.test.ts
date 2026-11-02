/**
 * ONE TEST LOCK PER MACHINE, NOT PER CHECKOUT.
 *
 * The lock lived at each checkout's root, so a run in a git worktree and a run in the main checkout
 * could not see each other, ran at once and exhausted memory. Every checkout of the repository now
 * resolves the lock inside the one git directory they share.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sharedGitDir, LOCK_PATH } = require('../scripts/lib/test-run-lock.cjs') as {
  sharedGitDir: (root: string) => string | null;
  LOCK_PATH: string;
};

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-lock-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('where the test lock lives', () => {
  it('is the checkout\'s own .git directory in the main checkout', () => {
    const main = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(main, '.git'), { recursive: true });
    expect(sharedGitDir(main)).toBe(path.join(main, '.git'));
  });

  it('is the main checkout\'s .git from a worktree, not the worktree\'s own git directory', () => {
    const main = path.join(tmp, 'repo');
    const own = path.join(main, '.git', 'worktrees', 'feature');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'commondir'), '../..\n');
    const worktree = path.join(main, '.claude', 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${own}\n`);
    expect(sharedGitDir(worktree)).toBe(path.join(main, '.git'));
  });

  it('falls back to the repo root outside a git checkout', () => {
    expect(sharedGitDir(path.join(tmp, 'tarball'))).toBeNull();
  });

  it('resolves this checkout to a lock in a shared git directory', () => {
    expect(path.basename(LOCK_PATH)).toBe('ae-test-run.lock');
    expect(path.basename(path.dirname(LOCK_PATH))).toBe('.git');
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { holderIsLive, processIdentity } = require('../scripts/lib/test-run-lock.cjs') as {
  holderIsLive: (held: unknown, probe?: { alive?: (pid: number) => boolean; identityOf?: (pid: number) => unknown }) => boolean;
  processIdentity: (pid: number) => { name: string; started: string } | null | undefined;
};

describe('who holds the test lock', () => {
  const recorded = { name: 'node.exe', started: '2026-10-19T06:00:00.0000000Z' };
  const held = { pid: 4242, label: 'test run', startedAt: '2026-10-19T06:00:01.000Z', process: recorded };
  const probe = (now: unknown) => ({ alive: () => true, identityOf: () => now });

  it('is the process that wrote the lock while its pid still names it', () => {
    expect(holderIsLive(held, probe({ ...recorded }))).toBe(true);
  });

  it('is nobody once the operating system has handed the pid to another process', () => {
    // The reuse this guards against: a killed run's pid taken by svchost, which answers EPERM, so alive.
    expect(holderIsLive(held, probe({ name: 'svchost.exe', started: '2026-10-19T09:30:00.0000000Z' }))).toBe(false);
    // The same executable name is not enough: another node started later is another process.
    expect(holderIsLive(held, probe({ name: 'node.exe', started: '2026-10-19T09:30:00.0000000Z' }))).toBe(false);
  });

  it('is nobody when the pid is free', () => {
    expect(holderIsLive(held, { alive: () => false, identityOf: () => recorded })).toBe(false);
    expect(holderIsLive(held, probe(null))).toBe(false);
  });

  it('judges a lock that records no identity by whether the pid names a node process', () => {
    const legacy = { pid: 4242, label: 'test run', startedAt: '2026-10-19T06:00:01.000Z' };
    expect(holderIsLive(legacy, probe({ name: 'svchost.exe', started: 'x' }))).toBe(false);
    expect(holderIsLive(legacy, probe({ name: '/usr/local/bin/node', started: 'x' }))).toBe(true);
  });

  it('falls back to the pid alone only where the platform cannot say who holds it', () => {
    expect(holderIsLive(held, probe(undefined))).toBe(true);
  });

  it('reads the same identity twice for this process, and none for a pid nothing holds', () => {
    const mine = processIdentity(process.pid);
    if (mine === undefined) return; // a platform that cannot say; the fallback above covers it
    expect(mine).toEqual(processIdentity(process.pid));
    expect(holderIsLive({ pid: process.pid, process: mine })).toBe(true);
    expect(holderIsLive({ pid: process.pid, process: { ...mine, started: 'another start' } })).toBe(false);
  }, 60_000);
});
