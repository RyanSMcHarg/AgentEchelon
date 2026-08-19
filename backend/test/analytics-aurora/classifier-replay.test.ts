/**
 * The classification shadow gate's replay job (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5.2).
 *
 * What is pinned here is what the job REFUSES to replay, and whether it says so. Each exclusion is a
 * correctness or a privacy obligation, and all three fail the same quiet way: the run completes, the
 * numbers look fine, and the corpus is not what the operator thinks it is.
 */
import type { ReplayLabel } from '../../lambda/src/lib/classifier-gate';
import { getModelCatalog, bedrockInvokeId } from '../../lib/config/model-strategy';

const mockQuery = jest.fn();
const mockClassify = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

// The real fast-path predicate, deliberately NOT mocked: the exclusion it drives has to agree with
// the classifier's own behaviour, and stubbing it would test a copy of the rule instead of the rule.
jest.mock('../../lambda/src/lib/intent-classifier', () => {
  const actual = jest.requireActual('../../lambda/src/lib/intent-classifier');
  return { ...actual, classifyIntent: mockClassify };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startClassifierReplay, openClassifierReplay, adjudicateReplayLabel, listReplayLabels } =
  require('../../lambda/src/analytics-aurora/classifier-replay');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const replayHandler = require('../../lambda/src/analytics-aurora/classifier-replay-handler');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { evaluateClassifierGate } = require('../../lambda/src/lib/classifier-gate');

/** A candidate row as `selectCandidates` returns it. */
const candidate = (over: Record<string, unknown> = {}) => ({
  exchange_id: 'ex-1',
  message_id: 'msg-1',
  content: 'how do I export the quarterly numbers?',
  retracted: false,
  ...over,
});

/**
 * Drive the mocked query() through the job's call sequence: INSERT run -> SELECT candidates ->
 * (INSERT label)* -> UPDATE run. Label inserts and the final update are matched by SQL shape rather
 * than by call index, so adding a query does not silently rewire the fixture.
 */
function primeQueries(candidates: Array<Record<string, unknown>>) {
  const labelWrites: unknown[][] = [];
  let runUpdate: unknown[] | null = null;
  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/INSERT INTO classifier_replay_runs/.test(sql)) return { rows: [{ id: 'run-1' }] };
    if (/FROM exchanges e/.test(sql)) return { rows: candidates };
    if (/INSERT INTO classifier_replay_labels/.test(sql)) {
      labelWrites.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE classifier_replay_runs/.test(sql)) {
      runUpdate = params;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { labelWrites, runUpdate: () => runUpdate };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockClassify.mockReset();
  mockClassify.mockResolvedValue({ intent: 'general', confidence: 'medium' });
});

describe('startClassifierReplay: what it refuses to replay', () => {
  it('NEVER replays a retracted message, and reports how many it declined', async () => {
    // A redaction or deletion means a participant asked for that text to stop being readable.
    // Pushing it through two models is exactly the quiet reuse the request exists to prevent.
    const { labelWrites, runUpdate } = primeQueries([
      candidate({ exchange_id: 'ex-1' }),
      candidate({ exchange_id: 'ex-2', retracted: true }),
      candidate({ exchange_id: 'ex-3', retracted: true }),
    ]);

    const out = await startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' });

    expect(out.status).toBe('complete');
    expect(out.messagesConsidered).toBe(3);
    expect(out.messagesRetracted).toBe(2);
    expect(out.messagesReplayed).toBe(1);
    expect(labelWrites).toHaveLength(1);
    // The retracted ids never reach a model.
    const classified = mockClassify.mock.calls.map((c) => c[0]);
    expect(classified).toHaveLength(2); // one message, two candidate models
    // And the counts are written to the run, not just returned.
    expect(runUpdate()).toEqual(expect.arrayContaining([3, 1, 2]));
  });

  it('excludes fast-path messages, because no model is consulted for them', async () => {
    // Both candidates would "agree" on every greeting without being asked. Counting them pads the
    // corpus with pairs that cannot distinguish the models AND shrinks the accuracy difference
    // between them, because that difference is measured over the whole corpus.
    const { labelWrites } = primeQueries([
      candidate({ exchange_id: 'ex-1', content: 'hi' }),
      candidate({ exchange_id: 'ex-2', content: 'thanks' }),
      candidate({ exchange_id: 'ex-3', content: 'ok' }),
      candidate({ exchange_id: 'ex-4', content: 'what is our refund policy?' }),
    ]);

    const out = await startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' });

    expect(out.messagesFastPath).toBe(3);
    expect(out.messagesReplayed).toBe(1);
    expect(labelWrites).toHaveLength(1);
  });

  it('skips a message with no readable content', async () => {
    const { labelWrites } = primeQueries([
      candidate({ exchange_id: 'ex-1', content: null }),
      candidate({ exchange_id: 'ex-2', content: '   ' }),
      candidate({ exchange_id: 'ex-3' }),
    ]);
    const out = await startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' });
    // '   ' trims to empty, which the fast path answers as a greeting rather than sending to a model.
    expect(out.messagesReplayed).toBe(1);
    expect(labelWrites).toHaveLength(1);
  });

  it('derives retraction from the -RED/-DEL sibling row, not the moderation audit table', async () => {
    // The audit table records only WHO acted, is written best-effort, and is keyed on the Chime
    // message id rather than the messages PK. The sibling row is the authority.
    primeQueries([candidate()]);
    await startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' });
    const selectSql = mockQuery.mock.calls.map((c) => String(c[0])).find((s) => /FROM exchanges e/.test(s))!;
    expect(selectSql).toContain('REDACT_CHANNEL_MESSAGE');
    expect(selectSql).toContain('DELETE_CHANNEL_MESSAGE');
    expect(selectSql).not.toMatch(/JOIN\s+moderation_actions/i);
  });
});

describe('startClassifierReplay: the pairing and the window', () => {
  it('shows BOTH candidates the same message', async () => {
    // The pairing is what makes this design cheap: it removes between-sample variance, so the same
    // conclusion needs far less traffic than a split. Classifying different messages would throw it
    // away silently and still produce a plausible-looking result.
    primeQueries([candidate({ content: 'draft the Q3 summary' })]);
    await startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' });

    expect(mockClassify).toHaveBeenCalledTimes(2);
    const [firstMsg, firstOpts] = mockClassify.mock.calls[0];
    const [secondMsg, secondOpts] = mockClassify.mock.calls[1];
    expect(firstMsg).toBe(secondMsg);

    // THE KEY IS RESOLVED TO A BEDROCK ID BEFORE THE MODEL CALL.
    //
    // This used to assert the raw keys reached `classifyIntent`, which encoded the defect: `modelId` is
    // passed straight to `ConverseCommand`, so 'haiku' as a modelId is not a model - it is a string
    // Bedrock rejects. The run only ever succeeded when an operator typed a real Bedrock id into what was
    // a free-text field, and that id could then never match the catalog KEY the experiment form holds,
    // so the classifier gate never cleared and every classification experiment was refused.
    //
    // Keys are now the stored/compared vocabulary (validated against the catalog) and the id is derived
    // here, where the deployment's region and account are known. Expected values are computed through
    // `bedrockInvokeId` rather than written out, so this cannot drift when a model's id changes.
    const catalog = getModelCatalog(process.env.AWS_REGION || 'us-east-1', process.env.AWS_ACCOUNT_ID || '');
    const expected = [bedrockInvokeId(catalog.haiku), bedrockInvokeId(catalog.sonnet)].sort();
    expect([firstOpts.modelId, secondOpts.modelId].sort()).toEqual(expected);
    // And they are ids, not the keys that were passed in.
    expect([firstOpts.modelId, secondOpts.modelId]).not.toContain('haiku');
  });

  it('refuses a model that is not in the catalog, rather than AccessDenying at the call', async () => {
    // The gate's write path is now under the same rule as a profile activation and an experiment
    // variant: confirm the model is in the catalog at the point it is selected.
    primeQueries([candidate()]);
    await expect(
      startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'gpt-9-turbo' }),
    ).rejects.toThrow(/not a model catalog key/);
  });

  it('records the window on the run, because a stale corpus is not evidence about today', async () => {
    primeQueries([candidate()]);
    const out = await startClassifierReplay({
      incumbentModel: 'haiku',
      challengerModel: 'sonnet',
      windowDays: 7,
    });
    const span = Date.parse(out.windowEnd) - Date.parse(out.windowStart);
    expect(Math.round(span / 86_400_000)).toBe(7);
  });

  it('marks a pair concordant only when the two labels match', async () => {
    const { labelWrites } = primeQueries([candidate({ exchange_id: 'a' }), candidate({ exchange_id: 'b' })]);
    mockClassify
      .mockResolvedValueOnce({ intent: 'general', confidence: 'medium' })
      .mockResolvedValueOnce({ intent: 'general', confidence: 'medium' })
      .mockResolvedValueOnce({ intent: 'general', confidence: 'medium' })
      .mockResolvedValueOnce({ intent: 'data_extraction', confidence: 'high' });

    await startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' });

    expect(labelWrites).toHaveLength(2);
    expect(labelWrites[0][5]).toBe(true);
    expect(labelWrites[1][5]).toBe(false);
  });

  it('refuses a replay of a model against itself', async () => {
    // Not a spend guard: it would produce a corpus of agreements and an "indistinguishable" verdict
    // that says nothing about anything.
    await expect(
      startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'haiku' }),
    ).rejects.toThrow(/must differ/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('requires both models', async () => {
    await expect(startClassifierReplay({ incumbentModel: '', challengerModel: 'sonnet' })).rejects.toThrow();
  });
});

describe('opening a run under a CALLER-SUPPLIED id', () => {
  // The id has to be mintable outside the VPC, because the function that answers the operator's
  // click is outside it — an in-VPC function cannot invoke the batch Lambda at all (no route to the
  // Lambda control plane). If this INSERT ignored the supplied id, the console would poll an id the
  // database never used and every replay would read as "never opened".
  it('opens the row under the id it was given', async () => {
    let insertParams: unknown[] | null = null;
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO classifier_replay_runs/.test(sql)) {
        insertParams = params;
        return { rows: [{ id: 'supplied-run-id' }] };
      }
      return { rows: [] };
    });

    const out = await openClassifierReplay({
      incumbentModel: 'haiku',
      challengerModel: 'sonnet',
      runId: 'supplied-run-id',
    });

    expect(out.runId).toBe('supplied-run-id');
    expect(insertParams).toContain('supplied-run-id');
  });

  it('still lets the database mint one when no id is supplied', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'db-minted' }] });
    const out = await openClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' });
    expect(out.runId).toBe('db-minted');
  });

  it('treats a REDELIVERED open as opened, not as a failure', async () => {
    // An `Event` invocation can be delivered more than once. `ON CONFLICT DO NOTHING` returns no row
    // the second time; reading that as "failed to open" would mark a perfectly good run as broken.
    mockQuery.mockResolvedValue({ rows: [] });
    const out = await openClassifierReplay({
      incumbentModel: 'haiku',
      challengerModel: 'sonnet',
      runId: 'already-there',
    });
    expect(out.runId).toBe('already-there');
  });

  it('fails loudly when there is no id from either side', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(
      openClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' }),
    ).rejects.toThrow(/failed to open/);
  });
});

describe('the batch handler opens the run it was asked to open', () => {
  it('opens THEN executes when the event carries `open`', async () => {
    const seen: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      if (/INSERT INTO classifier_replay_runs/.test(sql)) { seen.push('open'); return { rows: [{ id: 'run-9' }] }; }
      if (/FROM classifier_replay_runs/.test(sql)) {
        seen.push('read');
        return { rows: [{
          id: 'run-9', experiment_id: null, incumbent_model: 'haiku', challenger_model: 'sonnet',
          window_start: new Date().toISOString(), window_end: new Date().toISOString(),
        }] };
      }
      if (/FROM exchanges e/.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    await replayHandler.handler({ runId: 'run-9', limit: 5, open: { incumbentModel: 'haiku', challengerModel: 'sonnet' } });

    // The order matters: executing first would read a run that does not exist yet and record a
    // failure against an id whose row is about to appear.
    expect(seen[0]).toBe('open');
    expect(seen).toContain('read');
  });

  it('does NOT open anything for an already-open run', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM classifier_replay_runs/.test(sql)) {
        return { rows: [{
          id: 'run-9', experiment_id: null, incumbent_model: 'haiku', challenger_model: 'sonnet',
          window_start: new Date().toISOString(), window_end: new Date().toISOString(),
        }] };
      }
      return { rows: [] };
    });

    await replayHandler.handler({ runId: 'run-9', limit: 5 });

    const inserts = mockQuery.mock.calls.filter((c) => /INSERT INTO classifier_replay_runs/.test(String(c[0])));
    expect(inserts).toHaveLength(0);
  });

  it('rethrows when the run cannot be opened, because there is no run to record it on', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/INSERT INTO classifier_replay_runs/.test(sql)) throw new Error('aurora unavailable');
      return { rows: [] };
    });

    await expect(
      replayHandler.handler({ runId: 'run-9', open: { incumbentModel: 'haiku', challengerModel: 'sonnet' } }),
    ).rejects.toThrow(/aurora unavailable/);
  });
});

describe('startClassifierReplay: failure', () => {
  it('RECORDS a failed run instead of leaving a truncated corpus looking complete', async () => {
    let updateParams: unknown[] | null = null;
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO classifier_replay_runs/.test(sql)) return { rows: [{ id: 'run-1' }] };
      if (/FROM exchanges e/.test(sql)) throw new Error('aurora unavailable');
      if (/UPDATE classifier_replay_runs/.test(sql)) { updateParams = params; return { rows: [] }; }
      return { rows: [] };
    });

    const out = await startClassifierReplay({ incumbentModel: 'haiku', challengerModel: 'sonnet' });
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/aurora unavailable/);
    expect(String(updateParams)).toMatch(/aurora unavailable/);
  });
});

describe('adjudication', () => {
  it('will not accept a ruling on a CONCORDANT pair', async () => {
    // A concordant pair carries no comparative signal whatever the truth, so a ruling on one is
    // labelling effort that moves no number - and accepting it would imply the queue was incomplete.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await adjudicateReplayLabel({
      labelId: 'label-1',
      trueLabel: 'general',
      adjudicatedBy: 'admin@example.com',
    });
    expect(res.updated).toBe(false);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/concordant\s*=\s*FALSE/i);
  });

  it('writes true_label and never touches proposed_label', async () => {
    // A model may propose a label to speed the queue. This write is the only thing that sets the
    // answer, so a proposal cannot become one by sitting next to it (INV-4).
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await adjudicateReplayLabel({
      labelId: 'label-1',
      trueLabel: 'data_extraction',
      adjudicatedBy: 'admin@example.com',
      note: 'the user asked for a figure, not a report',
    });
    expect(res.updated).toBe(true);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('true_label');
    expect(sql).not.toContain('proposed_label');
  });

  it('requires a ruler and a ruling', async () => {
    await expect(
      adjudicateReplayLabel({ labelId: 'l', trueLabel: '', adjudicatedBy: 'a' }),
    ).rejects.toThrow();
    await expect(
      adjudicateReplayLabel({ labelId: 'l', trueLabel: 'general', adjudicatedBy: '' }),
    ).rejects.toThrow();
  });
});

describe('the adjudication queue', () => {
  it('serves DISCORDANT and unadjudicated pairs only', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await listReplayLabels('run-1', { pendingOnly: true });
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/concordant\s*=\s*FALSE/i);
    expect(sql).toMatch(/adjudicated_at IS NULL/i);
  });

  it('reports the full total so a partly-worked queue cannot read as finished', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: '1', exchange_id: 'e1', incumbent_label: 'general', challenger_label: 'data_extraction', total_count: '37' },
      ],
    });
    const out = await listReplayLabels('run-1', { pendingOnly: true, limit: 1 });
    expect(out.rows).toHaveLength(1);
    expect(out.total).toBe(37);
  });
});

describe('replay to gate, end to end', () => {
  it('a replay whose queue is unworked yields no verdict', async () => {
    // The join between the two halves: the job produces labels, the gate refuses to conclude from
    // them until a human has ruled. Neither half can decide on its own.
    const labels: ReplayLabel[] = [
      { incumbentLabel: 'general', challengerLabel: 'general' },
      { incumbentLabel: 'general', challengerLabel: 'data_extraction' },
    ];
    expect(evaluateClassifierGate(labels).verdict).toBe('insufficient');
  });
});
