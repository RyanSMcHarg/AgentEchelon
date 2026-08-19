/**
 * The accuracy margin is declared in TWO places, so pin them together.
 *
 * Backend  `lambda/src/lib/experiment-stats.ts`  - source of truth, carries the rationale, used by the
 *          guardrail evaluation and the §5 classification gate.
 * Frontend `frontend/packages/shared/src/services/experimentService.ts` - what the create form
 *          pre-fills, needed at CREATE time when no recommendation payload exists to carry it.
 *
 * There is no module boundary the two can share (the Lambda source is not importable from the browser
 * bundle), and the sibling tunable `MIN_SAMPLE_PER_VARIANT` avoids this only because it is delivered
 * on the recommendation payload - which is not available before an experiment exists.
 *
 * So the duplication is deliberate, and this test is the thing that makes it safe: change one and the
 * build fails until the other follows. Without it the two drift silently, and a console pre-filling a
 * margin the evaluator does not apply is exactly the class of defect this repo keeps finding.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_ACCURACY_MARGIN_PCT } from '../../lambda/src/lib/experiment-stats';

const SHARED = path.resolve(
  __dirname, '..', '..', '..', 'frontend', 'packages', 'shared', 'src', 'services', 'experimentService.ts',
);

describe('accuracy margin parity (backend <-> frontend)', () => {
  it('the backend value is a sane percentage', () => {
    expect(Number.isFinite(DEFAULT_ACCURACY_MARGIN_PCT)).toBe(true);
    expect(DEFAULT_ACCURACY_MARGIN_PCT).toBeGreaterThan(0);
    expect(DEFAULT_ACCURACY_MARGIN_PCT).toBeLessThanOrEqual(100);
  });

  it('the frontend declares the SAME value', () => {
    const src = fs.readFileSync(SHARED, 'utf8');
    const m = src.match(/export const DEFAULT_ACCURACY_MARGIN_PCT\s*=\s*([0-9.]+)/);
    if (!m) throw new Error(`DEFAULT_ACCURACY_MARGIN_PCT not found in ${SHARED}`);
    expect(Number(m[1])).toBe(DEFAULT_ACCURACY_MARGIN_PCT);
  });
});
