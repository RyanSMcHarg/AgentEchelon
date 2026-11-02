/**
 * The browser's performance metric names match the ones the ingestion Lambda accepts.
 *
 * WHY A COPY EXISTS. `VALID_PERF_METRICS` in `lambda/src/lib/client-event-types.ts` is the one
 * declaration the Lambda rejects against. A browser bundle cannot import backend source, so
 * `frontend/packages/shared/src/services/eventTrackingService.ts` carries the names as the
 * `PerfMetricName` union, and TypeScript holds every `trackPerformance` call to that union.
 *
 * WHY THE COPY NEEDS A GUARD. A metric added to the frontend alone is rejected on arrival and its
 * panel stays empty with nothing failing; a metric removed from the backend alone does the same to a
 * metric already shipping. Both directions are checked, as sets.
 *
 * It also reads every literal passed to `trackPerformance(` / `startTimer(` in the frontend packages,
 * so a call that escapes the type (a cast, a `// @ts-expect-error`) is still caught.
 */
import * as fs from 'fs';
import * as path from 'path';
import { VALID_PERF_METRICS } from '../lambda/src/lib/client-event-types';

const FRONTEND = path.join(__dirname, '../../frontend/packages');
const EMITTER = path.join(FRONTEND, 'shared/src/services/eventTrackingService.ts');

function unionMembers(src: string, typeName: string): string[] {
  const m = new RegExp(`export\\s+type\\s+${typeName}\\s*=([^;]+);`).exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('client performance metric names', () => {
  it('the emitter union and the Lambda allow-list are the same set', () => {
    const union = unionMembers(fs.readFileSync(EMITTER, 'utf8'), 'PerfMetricName');
    // An empty read would pass the comparison below only if the backend were empty too; say so.
    expect(union.length).toBeGreaterThan(0);
    expect([...union].sort()).toEqual([...VALID_PERF_METRICS].sort());
  });

  it('every literal metric the frontend emits is accepted', () => {
    const accepted = new Set<string>(VALID_PERF_METRICS);
    const emitted: string[] = [];
    const unknown: string[] = [];
    for (const file of sourceFiles(FRONTEND)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\b(?:trackPerformance|startTimer|endTimer)\(\s*'([^']+)'/g)) {
        emitted.push(m[1]);
        if (!accepted.has(m[1])) unknown.push(`${path.relative(FRONTEND, file)}: ${m[1]}`);
      }
    }
    // The scan is wired to the tree: the web vitals and both latency timings are emitted today.
    expect(emitted.length).toBeGreaterThanOrEqual(VALID_PERF_METRICS.length);
    expect(unknown).toEqual([]);
  });
});
