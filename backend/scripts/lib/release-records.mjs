/**
 * WHERE A RELEASE'S RECORDS LIVE (DESIGN-RELEASE-EVIDENCE section 8): `backend/test-results/release/<commit>/`,
 * one file per step, never cleared, since each commit has its own directory. Each step appends what it found
 * when it finishes, stamped with the commit it ran against; the report reads them last.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPORT_DIR = path.join(BACKEND_ROOT, 'test-results');

/** The directory holding one commit's records. */
export function releaseDir(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a full commit id: ${commit}`);
  return path.join(REPORT_DIR, 'release', commit);
}

/** Every entry a step recorded for a commit, oldest first (an empty list when it never ran). */
export function readRecords(commit, step) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(releaseDir(commit), `${step}.json`), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append entries to a step's record for a commit. A later entry for the same item is the one judged. */
export function appendRecords(commit, step, entries) {
  const dir = releaseDir(commit);
  fs.mkdirSync(dir, { recursive: true });
  const all = [...readRecords(commit, step), ...entries.map((e) => ({ ...e, commit, at: new Date().toISOString() }))];
  fs.writeFileSync(path.join(dir, `${step}.json`), `${JSON.stringify(all, null, 2)}\n`);
}
