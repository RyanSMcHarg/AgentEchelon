/**
 * The analytics resource a request is posted to.
 *
 * Each analytics capability has its own resource (`admin-capability-map.ts`), and the handler refuses a
 * `queryType` - or, for a write, its `action` - on any other, so a test posts where the console does.
 * The Athena API mounts these under `/query`; the handler matches on the path's ending, so the same path
 * serves both analytics handlers in a test.
 */
import { capabilityForQueryType, ANALYTICS_CAPABILITY_SUBPATHS } from '../../lambda/src/lib/admin-capability-map';

export function analyticsPathFor(body: unknown): string {
  const b = (body ?? {}) as { queryType?: string; action?: string };
  const cap = capabilityForQueryType(String(b.queryType ?? ''), b.action);
  const sub = ANALYTICS_CAPABILITY_SUBPATHS.find((x) => x.capability === cap)?.path;
  return sub ? `/query/${sub}` : '/query';
}
