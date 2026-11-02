/**
 * A DRAFT ANSWERS THE GOLDEN SET BEFORE IT IS ACTIVATED, ON THE DEPLOYED API (ADR-065, SPEC-EVALUATION FR17).
 *
 * Through the signed routes the console uses: a labeled answer of the standard assistant is nominated into its
 * classification's golden set as a regression entry, copied from the de-identified copy; a draft is then refused at
 * Activate until it has been run against the set; the run answers on the classification's GoldenRun function and its
 * record names the draft's configId, its k, and the gate's decision; an edit after the run needs a new run, because a run
 * belongs to one configId; and an administrator activates the refused draft past the gate (ADR-065 decision 5): a
 * confirmation of a refusal that is not the one standing is refused, and the confirmed one activates the draft with the
 * refusal and the reason recorded on the version.
 *
 * ONE ACTIVATION, UNDONE. Every refusal is asserted on Activate itself, and the passing case on the gate Activate reads.
 * Only the override moves the live version, and the spec rolls it back to the version that served before, which a
 * rollback does without the gate. The entry this spec nominates is retired afterwards, verified by read-back: a
 * regression entry left behind would make every later activation of the assistant need a run.
 *
 * THE DE-IDENTIFIED COPY IS DERIVED ONCE A DAY. When the chosen answer has none yet, the spec runs the deployed batch once
 * on a sample, as `a-conversation-is-read-without-who-said-it.spec.ts` does, and nominates again.
 */
import { test, expect, declareWait, expectAlarm } from './helpers/fixtures';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { signedAnalyticsPost, signedAdminGet } from './helpers/signed-analytics';
import { getAdminUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { assistantServing } from './helpers/assistant-identity';
import { aws } from './helpers/aws';
import { physicalIdsIn, stackName } from './helpers/stack-prefix';
import { analyticsPathFor } from '../../backend/test/helpers/analytics-path';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

guardConsoleErrors();

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || '';
const profileUrl = (action: string) => adminUrl('assistant-admin', `/admin/profiles/${action}`);
/** The analytics resource a query or write is posted to, by its capability, as the console posts it. */
const analytics = (body: Record<string, unknown>) => `${ADMIN_API_URL}${analyticsPathFor(body)}`;

async function call(url: string, idToken: string, body: Record<string, unknown>): Promise<any> {
  try {
    return await signedAnalyticsPost(url, idToken, body);
  } catch (err) {
    return { __error: String((err as Error).message || err) };
  }
}

/** Run the deployed de-identification batch once on a small sample and wait for it to end. */
function deIdentifyASample(): void {
  const [fn] = physicalIdsIn([stackName('Archive')], { type: 'AWS::Lambda::Function', logicalId: /^CleanCopyBatchFunction/ });
  if (!fn) throw new Error(`no CleanCopyBatchFunction in ${stackName('Archive')}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
  const inFile = path.join(dir, 'in.json');
  fs.writeFileSync(inFile, JSON.stringify({ maxConversations: 5 }));
  aws(`lambda invoke --function-name ${fn} --cli-binary-format raw-in-base64-out --cli-read-timeout 0 --payload fileb://${inFile} ${path.join(dir, 'out.json')}`, { timeoutMs: 600_000 });
}

test.describe.serial('a draft answers the golden set before it is activated', () => {
  guardBackendErrors('a-draft-answers-the-golden-set-before-it-is-activated');
  test.skip(!hasTestCredentials() || !ADMIN_API_URL || !ADMIN_BASE_URL, 'Needs test users, VITE_ADMIN_API_URL and E2E_ADMIN_BASE_URL.');

  let idToken = '';
  let PROFILE = '';
  let CLASSIFICATION = '';
  let entryId = '';

  test.beforeAll(async ({ browser }) => {
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    PROFILE = assistantServing('standard');
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

  test('a labeled answer enters the set as a regression entry, from its de-identified copy', async () => {
    test.setTimeout(900_000);
    // The queue lists JUDGED answers nobody has labeled, every assistant's, so it is read wide. The standard assistant's
    // is preferred; otherwise the run is made for whichever declared assistant has one, since a run belongs to the
    // assistant whose set holds the entry.
    const queue = await call(analytics({ queryType: 'label_queue' }), idToken, { queryType: 'label_queue', days: 180, limit: 200 });
    const rows: any[] = (queue?.data ?? []).filter((r: any) => r.assistant && !String(r.assistant).startsWith('alt-') && r.conversation_classification && r.conversation_classification !== 'admin');
    rows.sort((a, b) => Number(b.assistant === PROFILE) - Number(a.assistant === PROFILE));
    // AN ANSWER WHOSE CONVERSATION ALREADY HAS ITS DE-IDENTIFIED COPY, derived after the answer: an entry is made only
    // from that copy, and the daily batch cannot be pointed at one conversation. Read as the console reads it, one audited
    // read at a time, and only as far as the first that qualifies.
    const hasCopy = async (r: any): Promise<boolean> => {
      const id = String(r.channel_arn).split('/').pop();
      const { status, body } = await signedAdminGet(adminUrl('admin-conversations', `/admin/conversations/${id}/clean`), idToken, { reason: 'e2e: golden set nomination' });
      return status === 200 && !!body?.derivedAt && Date.parse(body.derivedAt) > Date.parse(r.created_at);
    };
    const withCopy: any[] = [];
    for (const r of rows.slice(0, 25)) if (await hasCopy(r)) withCopy.push(r);
    if (!withCopy.length && rows.length) {
      // A sample-sized batch leaves the rest pending and says so to the operators, on purpose.
      expectAlarm('clean_copy_run');
      deIdentifyASample();
      for (const r of rows.slice(0, 25)) if (await hasCopy(r)) withCopy.push(r);
    }
    test.skip(!withCopy.length, `no judged, unlabeled answer with a de-identified copy (${rows.length} candidates read)`);

    // AN ENTRY THE RUN CAN ANSWER. One whose answer used a tool is recorded as not exercised and never reaches a model,
    // which would leave the answering path unproven, so such an entry is retired and the next candidate taken.
    const set = async () => (await call(analytics({ queryType: 'golden_set' }), idToken, { queryType: 'golden_set' }))?.data ?? [];
    for (const pick of withCopy.slice(0, 6)) {
      const label = { queryType: 'ground_truth', action: 'submit', exchangeId: pick.exchange_id, score: 90 };
      expect((await call(analytics(label), idToken, label))?.submitted, 'the label').toBe(true);
      const nominate = { queryType: 'golden_set', action: 'nominate', exchangeId: pick.exchange_id, purpose: 'regression' };
      const res = await call(analytics(nominate), idToken, nominate);
      expect(res?.submitted, `the nomination: ${JSON.stringify(res)}`).toBe(true);
      const entry = (await set()).find((e: any) => e.source_exchange_id === pick.exchange_id);
      expect(entry, 'the entry is listed under its classification').toBeTruthy();
      expect(entry.purpose).toBe('regression');
      expect(entry.conversation_classification).toBe(pick.conversation_classification);
      if (Array.isArray(entry.used_tools) && entry.used_tools.length) {
        const retire = { queryType: 'golden_set', action: 'retire', entryId: entry.id };
        await call(analytics(retire), idToken, retire);
        continue;
      }
      PROFILE = pick.assistant;
      CLASSIFICATION = pick.conversation_classification;
      entryId = entry.id;
      break;
    }
    test.skip(!entryId, 'every candidate answer used a tool, which a run does not exercise');
  });

  test('Activate is refused until the draft has been run against the set', async () => {
    test.setTimeout(180_000);
    test.skip(!entryId, 'no entry was nominated');
    const draft = await call(profileUrl('version'), idToken, { profileName: PROFILE });
    expect(draft?.draftConfigId, `a draft: ${JSON.stringify(draft)}`).toBeTruthy();
    const activated = await call(profileUrl('activate'), idToken, { profileName: PROFILE });
    expect(JSON.stringify(activated), 'Activate without a run').toMatch(/GOLDEN_RUN_REQUIRED|GOLDEN_RUN_OUTDATED/);
    const gate = await call(profileUrl('golden-gate'), idToken, { profileName: PROFILE });
    expect(gate?.available, 'the deployment has a golden run').toBe(true);
    expect(gate?.gate?.regressionEntries).toBeGreaterThan(0);
    expect(gate?.outcome?.proceed).toBe(false);
  });

  test('the run answers the set for the draft, and its record decides the gate', async () => {
    test.setTimeout(1_200_000);
    test.skip(!entryId, 'no entry was nominated');
    const started = await call(profileUrl('golden-run'), idToken, { profileName: PROFILE });
    expect(started?.runId, `the run started: ${JSON.stringify(started)}`).toBeTruthy();
    // The run is the function's own batch, minutes of model calls with no turn to watch, and it ends by its 15-minute
    // timeout at the latest; the gate reads it as failed a minute after that.
    declareWait('the golden run on the classification GoldenRun function', Date.now() + 16 * 60_000);

    let gate: any = null;
    await expect.poll(async () => {
      gate = await call(profileUrl('golden-gate'), idToken, { profileName: PROFILE });
      return gate?.gate?.run?.runId === started.runId ? gate.gate.run.status : 'not yet';
    }, { timeout: 1_100_000, intervals: [15_000] }).toMatch(/complete|failed/);

    const run = gate.gate.run;
    expect(run.status, `the run ended: ${run.error ?? ''}`).toBe('complete');
    expect(run.draftConfigId).toBe(started.draftConfigId);
    expect(run.k).toBe(3);
    expect(run.entriesDone).toBe(run.entriesTotal);
    expect(run.result.entries).toBe(run.entriesTotal);
    // The run answered: the entry this spec nominated used no tool, so at least one regression entry reached a model.
    expect(run.result.regressionExercised, 'regression entries the run answered').toBeGreaterThan(0);
    // The gate Activate reads agrees with the run's own decision.
    expect(gate.outcome.proceed).toBe(!run.result.refused);
    if (run.result.refused) expect(gate.outcome.code).toBe('GOLDEN_SET_REFUSED');

    // The Ground Truth tab shows the run against the entry.
    const set = await call(analytics({ queryType: 'golden_set' }), idToken, { queryType: 'golden_set' });
    const entry = (set?.data ?? []).find((e: any) => e.id === entryId);
    expect(entry?.last_run?.runId).toBe(started.runId);
  });

  test('an edit after the run needs a new run, because a run belongs to one configId', async () => {
    test.setTimeout(180_000);
    test.skip(!entryId, 'no entry was nominated');
    const edited = await call(profileUrl('draft'), idToken, { profileName: PROFILE, patch: { systemPromptAddendum: 'Answer in one short paragraph.' } });
    expect(edited?.draftConfigId, `the edit: ${JSON.stringify(edited)}`).toBeTruthy();
    const activated = await call(profileUrl('activate'), idToken, { profileName: PROFILE });
    expect(JSON.stringify(activated), 'Activate after an edit').toMatch(/GOLDEN_RUN_REQUIRED|GOLDEN_RUN_OUTDATED/);
  });

  test('an administrator activates the refused draft past the gate, confirmed and recorded on the version', async () => {
    test.setTimeout(180_000);
    test.skip(!entryId, 'no entry was nominated');
    // ANNOUNCED IN THE ADMIN CHANNEL by design (ADR-065 decision 5), so the watchdog expects the notice.
    expectAlarm('activated-past-golden-gate');
    const listing = async () => {
      const { body } = await signedAdminGet(adminUrl('assistant-admin', '/admin/profiles'), idToken);
      return (body?.profiles ?? []).find((p: any) => p.profileName === PROFILE);
    };
    const before = await listing();
    const previous = before?.activeVersion;
    expect(previous, `${PROFILE} serves a version`).toBeTruthy();
    const gate = await call(profileUrl('golden-gate'), idToken, { profileName: PROFILE });
    const refusal = gate?.outcome;
    expect(refusal?.proceed, `the gate refuses the edited draft: ${JSON.stringify(gate)}`).toBe(false);

    // The refusal as the console shows it: its code, its values and the run it was read from.
    const run = gate?.gate?.run?.draftConfigId === gate.draftConfigId ? gate.gate.run.runId : undefined;
    const shown = { code: refusal.code, params: refusal.params ?? {}, ...(run ? { runId: run } : {}) };

    // A confirmation of a refusal that is not the one standing is refused, and activates nothing.
    const wrongCode = refusal.code === 'GOLDEN_SET_REFUSED' ? 'GOLDEN_RUN_REQUIRED' : 'GOLDEN_SET_REFUSED';
    const stale = await call(profileUrl('activate-past-golden-gate'), idToken, { profileName: PROFILE, configId: gate.draftConfigId, ...shown, code: wrongCode, reason: 'e2e: a refusal that is not the one standing' });
    expect(JSON.stringify(stale), 'a changed refusal').toMatch(/GATE_CHANGED/);
    expect((await listing())?.activeVersion).toBe(previous);

    const reason = `e2e ${Date.now()}: activating past the gate to prove the override`;
    try {
      const passed = await call(profileUrl('activate-past-golden-gate'), idToken, { profileName: PROFILE, configId: gate.draftConfigId, ...shown, reason });
      expect(passed?.activatedPastGate, `the override: ${JSON.stringify(passed)}`).toMatchObject({ code: refusal.code, reason });
      const after = await listing();
      const active = (after?.versions ?? []).find((v: any) => v.active);
      expect(active?.version, 'a new version serves').toBeGreaterThan(previous);
      expect(active?.configId).toBe(gate.draftConfigId);
      expect(active?.activatedPastGate, 'the version records the refusal and the reason').toMatchObject({ code: refusal.code, reason });
    } finally {
      // PUT BACK WHAT SERVED BEFORE, whatever failed above: a rollback is not gated, and the e2e draft must not stay live.
      if ((await listing())?.activeVersion !== previous) {
        const rolledBack = await call(profileUrl('rollback'), idToken, { profileName: PROFILE, version: previous });
        expect(rolledBack?.version, `the rollback: ${JSON.stringify(rolledBack)}`).toBe(previous);
      }
    }
  });

  test.afterAll(async () => {
    if (!idToken) return;
    if (entryId) {
      const retire = { queryType: 'golden_set', action: 'retire', entryId };
      await call(analytics(retire), idToken, retire);
      const set = await call(analytics({ queryType: 'golden_set' }), idToken, { queryType: 'golden_set' });
      expect((set?.data ?? []).some((e: any) => e.id === entryId), 'CLEANUP FAILED - the e2e regression entry is still live').toBe(false);
    }
    // Reset the draft to a copy of the active version, which the override test rolled back to.
    if (PROFILE) await call(profileUrl('version'), idToken, { profileName: PROFILE });
  });
});
