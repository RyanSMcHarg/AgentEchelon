/**
 * THE STACK NAMES, read from `stack-names.json` beside this file: the one list `bin/backend.ts`, the
 * operator scripts (`scripts/lib/stack-lookup.cjs`) and the teardown (`scripts/teardown.mjs`) share.
 *
 * Read from JSON rather than declared here because the scripts are plain Node and do not compile
 * TypeScript: a list in a `.ts` file would be a second copy for them, and two copies drift.
 */
import * as fs from 'fs';
import * as path from 'path';

interface StackNames {
  current: string[];
  testOnly: string[];
  perClassification: string;
  perRegion: string;
  crossRegions: string[];
  retired: string[];
  retiredPerClassification: string[];
}

export const STACK_NAMES: Readonly<StackNames> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'stack-names.json'), 'utf8'),
);

/**
 * The stack id for `name` under `prefix`, refused when `name` is not a current or test-only stack, so
 * a stack the list does not know cannot be created and a retired name cannot come back.
 */
export function stackIdOf(prefix: string, name: string): string {
  const known = STACK_NAMES.current.includes(name)
    || STACK_NAMES.testOnly.includes(name)
    || (name.startsWith(STACK_NAMES.perClassification) && name.length > STACK_NAMES.perClassification.length)
    || (name.startsWith(STACK_NAMES.perRegion) && name.length > STACK_NAMES.perRegion.length);
  if (!known) {
    throw new Error(`stack "${name}" is not in lib/config/stack-names.json; add it to "current" (or "testOnly") before creating it`);
  }
  return `${prefix}${name}`;
}
