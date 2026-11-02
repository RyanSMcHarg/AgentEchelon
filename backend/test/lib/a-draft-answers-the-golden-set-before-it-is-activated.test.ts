/**
 * A DRAFT ANSWERS THE GOLDEN SET BEFORE IT IS ACTIVATED (ADR-065).
 *
 *  - One composer: the live turn and the run compose the system prompt through `composeAnswerPrompt`, and a run's
 *    context says nothing about a person beyond the entry's recorded reply preferences.
 *  - An entry carries what its answer was given: the tools it called, the registry's reply-preference keys and the
 *    de-identified turns before it, and nothing a person typed beyond the de-identified text.
 *  - The gate: a regression entry the draft fails refuses Activate; a missing, running or failed run refuses; an
 *    entry the run could not exercise is counted and never passes or fails; no set, or no golden run, proceeds.
 *  - The run refuses a classification other than its function's own.
 */
import * as fs from 'fs';
import * as path from 'path';
import { composeAnswerPrompt, goldenRunContext } from '../../lambda/src/lib/answer-prompt';
import { goldenSourceOf, precedingTurnsOf, runMessages, judgeTranscript } from '../../lambda/src/lib/golden-entry';
import { goldenGateOutcome, type GoldenGateRead } from '../../lambda/src/lib/golden-gate';
import { gateResult, type GateAttempt } from '../../lambda/src/lib/promotion-gate';
import { DEFAULT_INTENT_PACK } from '../../lambda/src/lib/intent-pack';
import { REPLY_PREFERENCES } from '../../lib/config/reply-preferences';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../lambda/src', rel), 'utf8');
const pass = (score?: number): GateAttempt => ({ ok: true, empty: false, blocked: false, breaches: [], score });

describe('one composer for the live turn and the run', () => {
  const base = { persona: 'You are Advisor.', hostSections: [], intent: 'general', pack: DEFAULT_INTENT_PACK, transcript: [{ content: 'hi' }] };

  it('the processor composes through it and appends none of its sections itself', () => {
    const processor = src('assistant-async-processor.ts');
    expect(processor).toContain('const composed = composeAnswerPrompt({');
    for (const inline of ['systemPrompt += replyPreferencesDirective', 'systemPrompt += userIdentityDirective', 'systemPrompt += intentAnswerPrompt']) {
      expect(processor).not.toContain(inline);
    }
    expect(src('analytics-aurora/golden-run.ts')).toContain('composeAnswerPrompt({');
  });

  it('a live turn greets and names the person; the run does neither', () => {
    const live = composeAnswerPrompt({ ...base, context: { senderDisplayName: 'Dana', greet: true, turnSections: [] } }).systemPrompt;
    expect(live).toContain('Dana');
    const run = composeAnswerPrompt({ ...base, context: goldenRunContext(null) }).systemPrompt;
    expect(run).not.toContain('<user_identity>');
    expect(run).not.toContain('FIRST message');
  });

  it("the run renders the entry's reply preferences as a live turn does, and the prefix ends at the persona", () => {
    const prefs = { answerStyle: Object.keys(REPLY_PREFERENCES.answerStyle.values).find((v) => v !== 'none')! };
    const live = composeAnswerPrompt({ ...base, context: { greet: false, replyPreferences: prefs, turnSections: [] } });
    const run = composeAnswerPrompt({ ...base, context: goldenRunContext(prefs) });
    expect(run.systemPrompt).toBe(live.systemPrompt);
    expect(run.systemPrompt).toContain('<reply_preferences>');
    expect(run.systemPrompt.slice(0, run.cacheablePrefixLength)).toContain('You are Advisor.');
    expect(run.systemPrompt.slice(0, run.cacheablePrefixLength)).not.toContain('<reply_preferences>');
  });
});

describe('what an entry carries from its answer', () => {
  it('keeps the tool names, and only reply preferences the registry declares', () => {
    const value = Object.keys(REPLY_PREFERENCES.answerStyle.values)[0];
    const s = goldenSourceOf({
      toolCalls: [{ name: 'load_company_context' }, { name: 'load_company_context' }, { name: 'platform_info' }, {}],
      replyPreferences: { answerStyle: value, madeUp: 'x', answerStyleTypo: value },
    });
    expect(s.usedTools).toEqual(['load_company_context', 'platform_info']);
    expect(s.replyPreferences).toEqual({ answerStyle: value });
    expect(goldenSourceOf(null)).toEqual({ usedTools: [], replyPreferences: null });
    expect(goldenSourceOf({ replyPreferences: { answerStyle: 'not-a-value' } }).replyPreferences).toBeNull();
  });

  it('stores the turns before the request oldest first, and the run joins them into a valid message list', () => {
    const turns = precedingTurnsOf([
      { actor_kind: 'assistant', text: 'Q3 was 4.1M.' },
      { actor_kind: 'person', text: 'What was Q3 revenue?' },
      { actor_kind: 'assistant', text: 'Welcome.' },
      { actor_kind: 'person', text: '   ' },
    ]);
    expect(turns).toEqual([
      { role: 'assistant', text: 'Welcome.' },
      { role: 'user', text: 'What was Q3 revenue?' },
      { role: 'assistant', text: 'Q3 was 4.1M.' },
    ]);
    // A leading assistant turn is dropped: a conversation opens on the user's side.
    expect(runMessages(turns, 'And Q4?')).toEqual([
      { role: 'user', content: 'What was Q3 revenue?' },
      { role: 'assistant', content: 'Q3 was 4.1M.' },
      { role: 'user', content: 'And Q4?' },
    ]);
    // Two user turns in a row are joined, because Converse refuses them.
    expect(runMessages([{ role: 'user', text: 'one' }], 'two')).toEqual([{ role: 'user', content: 'one\n\ntwo' }]);
    expect(runMessages(null, 'alone')).toEqual([{ role: 'user', content: 'alone' }]);
    expect(judgeTranscript(turns)).toBe('User: What was Q3 revenue?\nAssistant: Q3 was 4.1M.');
    expect(judgeTranscript(undefined)).toContain('first turn');
  });
});

describe('the gate at Activate', () => {
  const run = (over: Partial<NonNullable<GoldenGateRead['run']>> = {}): NonNullable<GoldenGateRead['run']> => ({
    runId: 'r', draftConfigId: 'cfg-2', status: 'complete', error: null, entriesTotal: 2, entriesDone: 2,
    result: gateResult([{ entryId: 'e1', purpose: 'regression', candidate: [pass(80)], baseline: [pass(70)] }]),
    ...over,
  });
  const gate = (r: GoldenGateRead['run'], regressionEntries = 1): GoldenGateRead => ({ entries: 2, regressionEntries, run: r });

  it('proceeds where there is no golden run to read, or no regression entry', () => {
    expect(goldenGateOutcome(null, 'cfg-2')).toEqual({ proceed: true, note: 'unavailable' });
    expect(goldenGateOutcome(gate(null, 0), 'cfg-2')).toEqual({ proceed: true, note: 'empty' });
  });

  it('refuses a draft with no run, a run of an earlier configId, a running run and a failed run', () => {
    expect(goldenGateOutcome(gate(null), 'cfg-2')).toMatchObject({ proceed: false, code: 'GOLDEN_RUN_REQUIRED' });
    expect(goldenGateOutcome(gate(run({ draftConfigId: 'cfg-1' })), 'cfg-2')).toMatchObject({ proceed: false, code: 'GOLDEN_RUN_REQUIRED' });
    expect(goldenGateOutcome(gate(run({ status: 'running', result: null, entriesDone: 1 })), 'cfg-2'))
      .toMatchObject({ proceed: false, code: 'GOLDEN_RUN_RUNNING' });
    expect(goldenGateOutcome(gate(run({ status: 'failed', result: null, error: 'timeout' })), 'cfg-2'))
      .toMatchObject({ proceed: false, code: 'GOLDEN_RUN_FAILED' });
  });

  it('refuses a draft that failed a regression entry, naming it, and passes one that did not', () => {
    const failed = gateResult([{ entryId: 'e1', purpose: 'regression', candidate: [pass(), { ...pass(), empty: true }], baseline: [pass(), pass()] }]);
    const out = goldenGateOutcome(gate(run({ result: failed })), 'cfg-2');
    expect(out).toMatchObject({ proceed: false, code: 'GOLDEN_SET_REFUSED', failures: [{ entryId: 'e1', attempt: 2, reason: 'empty' }] });
    expect(goldenGateOutcome(gate(run()), 'cfg-2')).toEqual({ proceed: true, note: 'passed' });
  });

  it('refuses a run that did not answer a regression entry nominated after it', () => {
    expect(goldenGateOutcome({ ...gate(run()), uncoveredRegression: 2 }, 'cfg-2'))
      .toMatchObject({ proceed: false, code: 'GOLDEN_RUN_OUTDATED', params: { count: 2 } });
  });

  it('a run that exercised no regression entry proceeds as unmeasured, never as passed', () => {
    const r = gateResult([{ entryId: 't', purpose: 'regression', candidate: [pass()], baseline: [pass()], notExercised: 'tools' }]);
    expect(r.regressionExercised).toBe(0);
    expect(goldenGateOutcome(gate(run({ result: r })), 'cfg-2')).toEqual({ proceed: true, note: 'unmeasured' });
  });

  it('an entry the run could not exercise never passes, fails or enters the paired difference', () => {
    const r = gateResult([
      { entryId: 'tool', purpose: 'regression', candidate: [{ ...pass(), ok: false }], baseline: [pass(90)], notExercised: 'tools' },
      { entryId: 'cap', purpose: 'capability', candidate: [pass(60)], baseline: [pass(50)], notExercised: 'tools' },
      { entryId: 'text', purpose: 'regression', candidate: [pass(70)], baseline: [pass(60)] },
    ]);
    expect(r.refused).toBe(false);
    expect(r.readyToPromote).toEqual([]);
    expect(r.notExercised).toEqual([{ entryId: 'tool', reason: 'tools' }, { entryId: 'cap', reason: 'tools' }]);
    expect(r.pairedDifference!.entries).toBe(1);
    expect(r.entries).toBe(3);
  });

  it('Activate reads the gate before it activates, and only the draft path does', () => {
    const handler = src('manage-profiles.ts');
    const activate = handler.slice(handler.indexOf("if (path.endsWith('/activate'))"));
    expect(activate.indexOf('goldenGateOutcome(')).toBeGreaterThan(-1);
    expect(activate.indexOf('goldenGateOutcome(')).toBeLessThan(activate.indexOf('await activateDraft('));
    // Activation is held to the configId the gate checked, so a draft saved in between is refused, not activated unrun.
    expect(activate).toContain('guardrailCatalogFor, pendingDraft?.configId);');
    const rollback = handler.slice(handler.indexOf("if (path.endsWith('/rollback'))"), handler.indexOf("if (path.endsWith('/rollback'))") + 800);
    expect(rollback).not.toContain('goldenGateOutcome(');
  });
});

describe('the run stays in its classification', () => {
  const prior = process.env.GOLDEN_RUN_CLASSIFICATION;
  afterEach(() => { process.env.GOLDEN_RUN_CLASSIFICATION = prior; });

  it("refuses a run of another classification, and runs nothing where it serves none", async () => {
    const { assertOwnClassification } = await import('../../lambda/src/analytics-aurora/golden-run');
    process.env.GOLDEN_RUN_CLASSIFICATION = 'standard';
    expect(assertOwnClassification('standard')).toBe('standard');
    expect(() => assertOwnClassification('premium')).toThrow(/standard runs only/);
    process.env.GOLDEN_RUN_CLASSIFICATION = '';
    expect(() => assertOwnClassification('standard')).toThrow(/serves no classification/);
  });

  it('a run still "running" past the function\'s 15 minutes reads as failed, so it never holds Activate shut', async () => {
    const { recordOf, RUN_DEADLINE_MS } = await import('../../lambda/src/analytics-aurora/golden-run');
    const started = new Date('2026-10-31T00:00:00Z');
    const row = { id: 'r', draft_config_id: 'c', k: 3, entries_total: 40, entries_done: 31, status: 'running', result: null, error: null, started_by: 's', started_at: started, completed_at: null };
    expect(recordOf(row, started.getTime() + 60_000).status).toBe('running');
    const late = recordOf(row, started.getTime() + RUN_DEADLINE_MS + 1);
    expect(late.status).toBe('failed');
    expect(late.error).toBe('deadline');
    expect(goldenGateOutcome({ entries: 40, regressionEntries: 5, run: { ...late } }, 'c')).toMatchObject({ code: 'GOLDEN_RUN_FAILED' });
  });

  it('groups recorded attempts by entry and side, carrying not-exercised', async () => {
    const { gateEntriesOf } = await import('../../lambda/src/analytics-aurora/golden-run');
    const row = { ok: true, empty: false, blocked: false, breaches: [], score: 70, not_exercised: null };
    const entries = gateEntriesOf([
      { ...row, entry_id: 'a', purpose: 'regression', side: 'draft' },
      { ...row, entry_id: 'a', purpose: 'regression', side: 'active' },
      { ...row, entry_id: 'b', purpose: 'capability', side: 'draft', not_exercised: 'tools' },
    ]);
    expect(entries).toEqual([
      { entryId: 'a', purpose: 'regression', candidate: [pass(70)], baseline: [pass(70)] },
      { entryId: 'b', purpose: 'capability', candidate: [pass(70)], baseline: [], notExercised: 'tools' },
    ]);
  });
});
