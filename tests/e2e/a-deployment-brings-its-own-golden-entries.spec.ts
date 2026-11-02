/**
 * A DEPLOYMENT BRINGS ITS OWN GOLDEN ENTRIES, ON THE DEPLOYED API (ADR-065 decisions 6 to 8, SPEC-EVALUATION FR27, FR29,
 * FR30).
 *
 * Through the signed routes the console uses, on the standard classification's declared assistant:
 *  - the sample upload in `backend/demo/golden-set/` enters the set as capability entries marked uploaded, with the email
 *    address in it removed by the clean copy's detector on the classification's GoldenRun function; the invalid sample is
 *    refused with each bad line named and nothing stored; the whole upload is retired by its id;
 *  - the gate reports coverage for every intent of the draft's pack, counting what was uploaded; with a minimum declared
 *    by the ACTIVE version, a draft is refused as `GOLDEN_SET_THIN` naming the intents below it, even when the draft
 *    itself lowers the minimum;
 *  - entries generated from the draft's intent pack by the utility model are stored as capability entries marked
 *    generated, and retired as one generation;
 *  - both run in the background, and the console is TOLD when each ends: the spec subscribes to the batch's channel on
 *    the console events API with the operator's console credentials before it starts the work, and waits for the event,
 *    which proves the async destination, the rule, the publisher and IAM on both sides; a wildcard subscription is refused.
 *
 * WHAT IT MOVES, AND PUTS BACK. Every entry it adds is retired, verified by read-back. Proving the minimum needs a version
 * that declares one to be active, so the spec activates one and rolls back to the version that served before, in a
 * `finally`, the way the override test does.
 */
import { test, expect, declareWait } from './helpers/fixtures';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { signedAnalyticsPost, signedAdminGet } from './helpers/signed-analytics';
import { getAdminUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { assistantServing } from './helpers/assistant-identity';
import { analyticsPathFor } from '../../backend/test/helpers/analytics-path';
import * as fs from 'fs';
import * as path from 'path';
import { followConsoleBatch, CONSOLE_EVENTS_HTTP, CONSOLE_EVENTS_REALTIME } from './helpers/console-events';
import { uploadIdFor } from '../../backend/lambda/src/lib/golden-upload';

guardConsoleErrors();

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || '';
const profileUrl = (action: string) => adminUrl('assistant-admin', `/admin/profiles/${action}`);
const analytics = (body: Record<string, unknown>) => `${ADMIN_API_URL}${analyticsPathFor(body)}`;
const SAMPLES = path.join(__dirname, '../../backend/demo/golden-set');

async function call(url: string, idToken: string, body: Record<string, unknown>): Promise<any> {
  try {
    return await signedAnalyticsPost(url, idToken, body);
  } catch (err) {
    return { __error: String((err as Error).message || err) };
  }
}

test.describe.serial('a deployment brings its own golden entries', () => {
  guardBackendErrors('a-deployment-brings-its-own-golden-entries');
  test.skip(!hasTestCredentials() || !ADMIN_API_URL || !ADMIN_BASE_URL, 'Needs test users, VITE_ADMIN_API_URL and E2E_ADMIN_BASE_URL.');
  test.skip(!CONSOLE_EVENTS_HTTP || !CONSOLE_EVENTS_REALTIME, 'Needs VITE_CONSOLE_EVENTS_HTTP and VITE_CONSOLE_EVENTS_REALTIME (validate.mjs resolves them from AdminServices).');

  let idToken = '';
  const PROFILE = assistantServing('standard');
  /** Every upload and generation this spec adds, retired afterwards. */
  const batches: string[] = [];

  const entries = async (): Promise<any[]> =>
    ((await call(analytics({ queryType: 'golden_set' }), idToken, { queryType: 'golden_set' }))?.data ?? [])
      .filter((e: any) => e.assistant === PROFILE);

  test.beforeAll(async ({ browser }) => {
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    const ctx = await browser.newContext({ baseURL: ADMIN_BASE_URL });
    const page = await ctx.newPage();
    try {
      await signIn(page, admin.email, admin.password);
      idToken = await idTokenOf(page);
    } finally {
      await ctx.close();
    }
    expect(idToken, 'admin idToken').toBeTruthy();
  });

  test('the sample upload enters as uploaded capability entries, de-identified, and the invalid one is refused line by line', async () => {
    test.setTimeout(180_000);
    const before = (await entries()).length;
    const invalid = await call(profileUrl('golden-set-import'), idToken, {
      profileName: PROFILE, format: 'jsonl', content: fs.readFileSync(path.join(SAMPLES, 'analyst-invalid.jsonl'), 'utf8'),
    });
    expect(invalid, `the invalid upload: ${JSON.stringify(invalid)}`).toMatchObject({ code: 'INVALID_LINES', params: { count: 8, lines: 9 } });
    expect(invalid.problems.map((p: any) => p.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await entries()).length, 'a refused upload stores nothing').toBe(before);

    // FOLLOWED BEFORE IT STARTS, so its end cannot be missed: an upload's id is its content's, known before it is sent.
    const content = fs.readFileSync(path.join(SAMPLES, 'analyst-valid.jsonl'), 'utf8');
    const uploadId = uploadIdFor(PROFILE, 'jsonl', content);
    const follow = followConsoleBatch(idToken, uploadId);
    try {
      await Promise.race([follow.ready, follow.refused.then((why) => { throw new Error(`the subscription was refused: ${why}`); })]);
      const valid = await call(profileUrl('golden-set-import'), idToken, { profileName: PROFILE, format: 'jsonl', content });
      expect(valid, `the valid upload: ${JSON.stringify(valid)}`).toMatchObject({ batchId: uploadId, kind: 'upload', status: 'running', entries: 7 });
      batches.push(uploadId);
      declareWait('the upload batch on the classification GoldenRun function', Date.now() + 5 * 60_000);
      const ended = await Promise.race([follow.ended, new Promise<never>((_, no) => setTimeout(() => no(new Error('no event within 5 minutes')), 5 * 60_000))]);
      expect(ended).toEqual({ id: uploadId, kind: 'upload', status: 'complete' });
    } finally {
      follow.close();
    }
    const batch = await call(profileUrl('golden-set-batch'), idToken, { profileName: PROFILE, batchId: uploadId });
    expect(batch?.batch, `the batch: ${JSON.stringify(batch)}`).toMatchObject({ status: 'complete', result: { imported: 7 } });
    const uploaded = (await entries()).filter((e) => e.upload_id === uploadId);
    expect(uploaded).toHaveLength(7);
    expect(uploaded.every((e) => e.source === 'uploaded' && e.purpose === 'capability')).toBe(true);
    const withEmail = uploaded.find((e) => String(e.request_text).includes('data warehouse'));
    expect(withEmail?.request_text, 'the detector removed the email address').not.toContain('pat.lee@example.com');
  });

  test('the gate reports coverage per intent, and the active version\'s minimum refuses a thin set', async () => {
    test.setTimeout(240_000);
    const listing = async () => {
      const { body } = await signedAdminGet(adminUrl('assistant-admin', '/admin/profiles'), idToken);
      return (body?.profiles ?? []).find((p: any) => p.profileName === PROFILE);
    };
    const previous = (await listing())?.activeVersion;
    expect(previous, `${PROFILE} serves a version`).toBeTruthy();

    const draft = await call(profileUrl('version'), idToken, { profileName: PROFILE });
    expect(draft?.draftConfigId, `a draft: ${JSON.stringify(draft)}`).toBeTruthy();
    const read = await call(profileUrl('golden-gate'), idToken, { profileName: PROFILE });
    const coverage: any[] = read?.gate?.coverage ?? [];
    expect(coverage.length, `coverage per intent: ${JSON.stringify(read?.gate)}`).toBeGreaterThan(0);
    const directory = coverage.find((c) => c.intent === 'directory_lookup');
    expect(directory?.uploaded, 'the uploaded entries are counted under their intent').toBeGreaterThanOrEqual(2);

    try {
      // A version declaring a minimum, activated. With no regression entry for the assistant, its own activation is not
      // gated by a run; if one is, the spec cannot prove the minimum without an override, so it says so.
      await call(profileUrl('draft'), idToken, { profileName: PROFILE, patch: { goldenSet: { minRegressionPerIntent: 1 } } });
      const activated = await call(profileUrl('activate'), idToken, { profileName: PROFILE });
      test.skip(!activated?.version, `the assistant's set gates its activation: ${JSON.stringify(activated)}`);

      // A draft that lowers the minimum is still measured against the active one's.
      await call(profileUrl('version'), idToken, { profileName: PROFILE });
      await call(profileUrl('draft'), idToken, { profileName: PROFILE, patch: { goldenSet: {} } });
      const gate = await call(profileUrl('golden-gate'), idToken, { profileName: PROFILE });
      expect(gate?.gate?.minRegressionPerIntent).toBe(1);
      expect(gate?.outcome, `the thin set: ${JSON.stringify(gate?.outcome)}`).toMatchObject({ proceed: false, code: 'GOLDEN_SET_THIN', params: { min: 1 } });
      const refused = await call(profileUrl('activate'), idToken, { profileName: PROFILE });
      expect(refused?.code).toBe('GOLDEN_SET_THIN');
    } finally {
      if ((await listing())?.activeVersion !== previous) {
        const rolledBack = await call(profileUrl('rollback'), idToken, { profileName: PROFILE, version: previous });
        expect(rolledBack?.version, `the rollback: ${JSON.stringify(rolledBack)}`).toBe(previous);
      }
      await call(profileUrl('version'), idToken, { profileName: PROFILE });
    }
  });

  test('entries generated from the draft\'s intent pack are stored as generated capability entries', async () => {
    test.setTimeout(180_000);
    const generationId = crypto.randomUUID();
    const follow = followConsoleBatch(idToken, generationId);
    try {
      await Promise.race([follow.ready, follow.refused.then((why) => { throw new Error(`the subscription was refused: ${why}`); })]);
      const started = await call(profileUrl('golden-set-generate'), idToken, {
        profileName: PROFILE, intents: ['directory_lookup', 'process_lookup'], perIntent: 1, generationId,
      });
      expect(started, `the generation: ${JSON.stringify(started)}`).toMatchObject({ batchId: generationId, kind: 'generation', status: 'running' });
      batches.push(generationId);
      declareWait('the generation batch on the classification GoldenRun function', Date.now() + 5 * 60_000);
      const ended = await Promise.race([follow.ended, new Promise<never>((_, no) => setTimeout(() => no(new Error('no event within 5 minutes')), 5 * 60_000))]);
      expect(ended).toEqual({ id: generationId, kind: 'generation', status: 'complete' });
    } finally {
      follow.close();
    }
    const batch = await call(profileUrl('golden-set-batch'), idToken, { profileName: PROFILE, batchId: generationId });
    expect(batch?.batch?.result, `the batch: ${JSON.stringify(batch)}`).toMatchObject({ generated: 2 });
    const rows = (await entries()).filter((e) => e.upload_id === generationId);
    expect(rows.map((e) => e.intent).sort()).toEqual(['directory_lookup', 'process_lookup']);
    expect(rows.every((e) => e.source === 'generated' && e.purpose === 'capability' && String(e.request_text).trim())).toBe(true);
  });

  test('DENIED: a wildcard subscription to every batch is refused', async () => {
    test.setTimeout(60_000);
    const follow = followConsoleBatch(idToken, '*');
    try {
      const outcome = await Promise.race([follow.ready.then(() => 'subscribed'), follow.refused.then(() => 'refused')]);
      expect(outcome).toBe('refused');
    } finally {
      follow.close();
    }
  });

  test.afterAll(async () => {
    if (!idToken) return;
    for (const uploadId of batches) {
      await call(profileUrl('golden-set-retire-upload'), idToken, { profileName: PROFILE, uploadId });
      await call(profileUrl('golden-set-retire-generation'), idToken, { profileName: PROFILE, uploadId });
    }
    const left = (await entries()).filter((e) => batches.includes(e.upload_id));
    expect(left, 'CLEANUP FAILED - entries this spec added are still live').toEqual([]);
  });
});
