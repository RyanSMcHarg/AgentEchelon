/**
 * THE EXPORT E2E NAMES THE INVENTORY, IN ITS ORDER.
 *
 * `tests/e2e/export.spec.ts` asserts an export's sections against a copy of the stores erasure walks,
 * because importing `offboarding.ts` would pull every AWS client it uses into the browser suite. The
 * copy fell four stores behind (agentTasks, channelContext, battleConfig, auroraProjection) and the live
 * export failed on a list nobody had updated. This keeps the copy equal to the source.
 */
import * as fs from 'fs';
import * as path from 'path';
import { OFFBOARDED_STORES, OFFBOARDING_KEPT } from '../lambda/src/lib/offboarding';

it('the export e2e lists the stores offboarding removes from, then the ones it keeps, in order', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'e2e', 'export.spec.ts'), 'utf8');
  const block = /const STORES = \[([\s\S]*?)\];/.exec(spec);
  expect(block).not.toBeNull();
  const listed = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(listed).toEqual([...OFFBOARDED_STORES, ...OFFBOARDING_KEPT]);
});
