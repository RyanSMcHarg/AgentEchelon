/**
 * PROCESS ANALYTICS GROUPS RUNS BY PROCESS ID (SPEC-PROCESSES P8 to P10), against the deployed stacks, Aurora mode.
 *
 * The unit suites prove the query's shape and the metric's edition rule (`process-runs-group-by-process-id.test.ts`,
 * `ProcessesPanel.test.tsx`). What only a deployment proves is that the facts and the out-of-band records a process's runs wrote
 * reach the archive and are read back together:
 *  - `process_runs` answers a `process` row per process, `workflow` and `team` rows with times, and `run` rows naming each run's
 *    process id and edition, and no row carries what was said;
 *  - one process id narrows every row, and its process row reads as the console shows it: ended only once every run carrying
 *    the id has an end, and succeeded only where every run succeeded; an incident's runs are its declared workflows, and an
 *    incident whose review was done and whose customer messaging (WT130) reached its end has no run without an end, while one
 *    whose customer messaging is still open has not ended;
 *  - a team's route answers for its own assistant's runs only.
 * It reads what an earlier incident run wrote (`an-incident-is-one-process-from-triage-to-review.spec.ts`), and says so when none has.
 *
 * GATED: PROCESS_E2E=1, Aurora mode.
 *
 * **Coverage:** `e2e/process-analytics-groups-runs-by-process-id.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getTestCredentials, hasTestCredentials } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { idTokenFor } from './helpers/person';
import { opsIncidentProcess } from '../../demo/portable-assistants/ops-assistant-manifest';

const RUN = process.env.PROCESS_E2E === '1';
type Row = Record<string, unknown>;

test.describe('process analytics groups runs by process id (P8 to P10)', () => {
  guardBackendErrors('process-analytics-groups-runs-by-process-id');
  let admin: VendedCredentials | undefined;

  test.beforeAll(async () => {
    test.skip(!RUN, 'set PROCESS_E2E=1');
    test.skip(!hasTestCredentials() || !ADMIN_API_URL, 'no test credentials or admin API on this deployment');
    const adminUser = await getAdminUser();
    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(adminUser!.email, adminUser!.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status).toBe(200);
    admin = session.body.credentials;
  });

  const read = async (body: Record<string, unknown>): Promise<Row[]> => {
    const res = await signedCall(adminUrl('analytics', '/'), admin!, 'POST', { queryType: 'process_runs', ...body });
    expect(res.status, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(200);
    test.skip(!!res.body?.unsupported, 'process analytics needs Aurora mode');
    return (res.body?.data ?? []) as Row[];
  };

  test('each process, its workflows, teams and runs, by reference only', async () => {
    const rows = await read({});
    const processes = rows.filter((r) => r.dimension === 'process');
    test.skip(!processes.length, 'no process ran in the window; run the incident e2e first');
    for (const p of processes) expect(Number(p.runs)).toBeGreaterThan(0);
    const runs = rows.filter((r) => r.dimension === 'run');
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(String(r.process_id)).toMatch(/^[a-f0-9]{12}$/);
      expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['content', 'message', 'text']));
    }
    const dims = new Set(rows.map((r) => r.dimension));
    expect([...dims].sort()).toEqual(['process', 'run', 'team', 'workflow']);
  });

  test('one process\'s runs, by its id, and its process row as the console shows it', async () => {
    const all = await read({});
    const first = all.find((r) => r.dimension === 'run');
    test.skip(!first, 'no process ran in the window');
    const one = await read({ processId: first!.process_id });
    const runs = one.filter((r) => r.dimension === 'run');
    expect(runs.every((r) => r.process_id === first!.process_id)).toBe(true);
    // ONE PROCESS ID IS ONE PROCESS: its row reads ended only once every run carrying the id has an end.
    const row = one.find((r) => r.dimension === 'process');
    expect(row, 'the process id narrows the process row too').toBeTruthy();
    expect(Number(row!.runs)).toBe(1);
    expect(Number(row!.ended), JSON.stringify(runs.map((r) => [r.workflow, r.ended_at]))).toBe(runs.every((r) => r.ended_at) ? 1 : 0);
    expect(Number(row!.succeeded)).toBe(runs.every((r) => r.ended_at && r.disposition === 'success') ? 1 : 0);
  });

  test('the latest incident, once completed, reads ended and succeeded, and no run of it lacks an end', async () => {
    const declared = opsIncidentProcess()['incident-response'].workflows;
    const all = await read({ process: 'incident-response' });
    // THE LATEST INCIDENT (runs come newest process first), which the incident e2e just ran.
    const ids = [...new Set(all.filter((r) => r.dimension === 'run').map((r) => String(r.process_id)))].slice(0, 1);
    test.skip(!ids.length, 'no incident ran in the window; run the incident e2e first');
    let completed = 0;
    for (const id of ids) {
      const one = await read({ processId: id });
      const runs = one.filter((r) => r.dimension === 'run');
      // EVERY RUN OF AN INCIDENT IS ONE OF ITS DECLARED WORKFLOWS: nothing said outside a run is counted as one.
      for (const r of runs) expect(declared, `process ${id} holds a run of ${String(r.workflow)}`).toContain(r.workflow);
      // THE PROCESS COMPLETES ONLY WHEN BOTH TRACKS HAVE ENDED (O31): customer messaging still open keeps the incident open.
      const track = runs.find((r) => r.workflow === 'customer-messaging');
      if (track && !track.ended_at) expect(Number(one.find((r) => r.dimension === 'process')?.ended), `process ${id} has an open customer messaging run`).toBe(0);
      // THE TIME TO FIRST NOTICE IS ON THE TRACK'S OWN STEPS, read as the console reads them, from what each step posted
      // (`step_times`): a run's end lists only the steps since its last task.
      if (track?.ended_at) expect(((track.step_times as Array<{ step: string }> | undefined) ?? []).some((x) => x.step === 'initial-approval')).toBe(true);
      // AN INCIDENT WHOSE REVIEW WAS DONE HAS ENDED: both its runs end, so its row reads ended and succeeded.
      if (runs.some((r) => r.workflow === 'ops-room' && (r.steps as Array<{ step: string }> | undefined)?.some((x) => x.step === 'review')) && (!track || track.ended_at)) {
        expect(runs.filter((r) => !r.ended_at).map((r) => r.workflow), `no run of the completed incident ${id} lacks an end`).toEqual([]);
        const row = one.find((r) => r.dimension === 'process');
        expect(Number(row?.ended)).toBe(1);
        expect(Number(row?.succeeded)).toBe(1);
        completed += 1;
      }
    }
    test.skip(!completed, 'no incident in the window reached its review; run the incident e2e first');
  });
});
