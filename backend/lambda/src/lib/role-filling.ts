/**
 * WHO STILL FILLS A ROLE, SAID ONCE (ADR-048, amended 2026-10-24).
 *
 * A role and the assistants filling it are separate, so a role is withdrawn only once no assistant fills it. Two
 * places ask: the deploy's provisioner, which refuses the withdrawal (`declared-assistants.ts`), and
 * `npm run add-assistant-role -- --remove`, which refuses it before it writes the config
 * (`scripts/add-assistant-role.mjs`, which reads the compiled copy of this module after its build). Both read this
 * module, so the build deadline and the rule cannot drift apart.
 *
 * Pure: no AWS client and no registry, so a script can load it without either.
 */
import type { DirectoryEntry } from './runtime-directory.js';

/**
 * How long after its create a build can still be running. The build's invoke is never retried and is
 * dropped if it waits longer than five minutes to start (`configureAsyncInvoke` on the function), and the
 * function times out at ten, so past twenty minutes no build of the entry is running or can start.
 */
export const BUILD_DEADLINE_MS = 20 * 60_000;

/**
 * The entry as an operator should see it. A `provisioning` entry past the build deadline is a build that
 * died without recording its end (a timeout, an out-of-memory kill), so it reads as `failed`, which the
 * roster shows with its reason and which retire accepts, rather than `provisioning` forever.
 */
export function withAbandonedBuild(entry: DirectoryEntry, now = Date.now()): DirectoryEntry {
  if (entry.status !== 'provisioning') return entry;
  const created = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
  if (!Number.isFinite(created) || now - created < BUILD_DEADLINE_MS) return entry;
  return { ...entry, status: 'failed', error: entry.error || 'the build did not finish' };
}

/** A status whose assistant exists, or is being built or retired: it fills its role until a retire finishes. */
export const FILLING_STATUSES: ReadonlySet<string> = new Set(['active', 'provisioning', 'retiring']);

/** Whether an entry's assistant still fills its role: a live one that is not retired and not a build that died. */
export function fillsItsRole(entry: DirectoryEntry, now = Date.now()): boolean {
  return (entry.occupancy ?? 'live') === 'live' && FILLING_STATUSES.has(withAbandonedBuild(entry, now).status);
}

/**
 * The assistants still filling a role of a classification, declared or created in the console: every live
 * directory entry at `(classification, role)` that is not retired and whose build is not a dead one.
 */
export function assistantsFilling(directory: Map<string, DirectoryEntry>, classification: string, role: string, now = Date.now()): string[] {
  return [...directory]
    .filter(([, e]) => !!e && e.classification === classification && e.role === role && fillsItsRole(e, now))
    .map(([n]) => n)
    .sort();
}

/** The assistants created in the console still active (or being built or retired) in a classification. */
export function consoleAssistantsIn(directory: Map<string, DirectoryEntry>, classification: string, now = Date.now()): string[] {
  return [...directory]
    .filter(([, e]) => !!e && e.classification === classification && e.origin !== 'declared')
    .filter(([, e]) => FILLING_STATUSES.has(withAbandonedBuild(e, now).status))
    .map(([n]) => n)
    .sort();
}
