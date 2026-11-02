/**
 * Retire the e2e experiments a previous run left live, before this run creates its own.
 *
 * A classification holds one live experiment at a time (DESIGN §3.2.1), so an experiment stranded by
 * a run that was killed before its `finally` ran makes every later create on that classification
 * answer 409 - and, before the server refused the overlap, it silently captured every later run's
 * traffic so each run read "no rows" for its own id. Teardown alone cannot fix
 * this: the run that strands one is exactly the run that did not get to tear down. Cleaning up on
 * the way IN is the version that survives it.
 *
 * Scoped to `e2e-` ids, so an operator's own experiment is never touched. `keep` names ids this run
 * already owns (the battle pair is armed before some callers run). A retire that fails throws: a
 * stranded experiment that could not be ended would surface later as an unrelated-looking 409.
 */
import { type SignedAdminContext } from './signed-analytics';
import { expect } from '@playwright/test';
import { adminUrl } from './api-urls';

export async function retireStrandedE2eExperiments(
  api: SignedAdminContext,
  experimentsApi: string,
  opts: { keep?: Iterable<string>; label?: string } = {},
): Promise<string[]> {
  const keep = new Set(opts.keep ?? []);
  const label = opts.label ?? 'e2e';
  const listed = await api.get(experimentsApi);
  expect(listed.ok(), `list experiments to sweep stranded e2e rows: ${listed.status()}`).toBeTruthy();
  const body = await listed.json().catch(() => ({} as Record<string, unknown>));
  const rows = body.experiments ?? body.data ?? body;
  const stranded = (Array.isArray(rows) ? rows : [])
    .map((e: Record<string, unknown>) => ({ id: String(e.experimentId ?? e.id ?? ''), status: e.status }))
    .filter((e) => e.id.startsWith('e2e-') && e.status === 'active' && !keep.has(e.id));
  for (const { id } of stranded) {
    console.log(`[${label}] retiring stranded experiment ${id} (left active by an earlier run)`);
    const resp = await api.post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}/status`), { data: { status: 'completed' } });
    expect(resp.ok(), `retire stranded experiment ${id}: ${resp.status()} ${await resp.text()}`).toBeTruthy();
  }
  return stranded.map((e) => e.id);
}
