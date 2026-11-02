/**
 * THE TURN'S ATTRIBUTION RIDES THE CLOSE-OUT, AND ITS COMPUTE DOES NOT.
 *
 * A turn that moves delivery to a new message - a broadcast answer, a privately targeted answer, or
 * an answer displaced to the end because its placeholder became the queue notice - leaves the
 * original placeholder behind as a receipt. Both exchange pairers take the earliest bot CREATE after
 * the user message from that sender, and the placeholder is always earlier than the message the
 * answer moved to, so the receipt wins the exchange and the answer keeps nothing.
 *
 * Measured live through the signed path on 2026-09-15: 220 exchanges, 31 minted against an
 * acknowledgment, 30 of those carrying NO intent.
 *
 * The turn already UPDATES that acknowledgment when it closes it out, so the declaration and the
 * attribution ride that update. The compute fields deliberately do not: a turn in this shape
 * produces TWO bot CREATE rows, and every token, cost and model figure is summed per message row.
 */
const {
  closeOutAttribution,
  CLOSE_OUT_ATTRIBUTION_KEYS,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('../../lambda/src/lib/turn-attribution');

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const core = read('lambda/src/lib/async-processor-core.ts');
const processor = read('lambda/src/assistant-async-processor.ts');
const notice = read('lambda/src/lib/turn-queue-notice.ts');
const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');

const A_WHOLE_TURN = {
  userMessageId: 'msg-user-1',
  intent: 'financial_metric',
  intentConfidence: 'high',
  deliveryOption: 'PLACEHOLDER_UPDATE',
  taskId: 'task-9',
};

describe('what the close-out declares', () => {
  it('names the message the turn answered, so the exchange is a declared pairing', () => {
    expect(closeOutAttribution(A_WHOLE_TURN)).toMatchObject({ answersMessageId: 'msg-user-1' });
  });

  it('carries the attribution, so the exchange minted against it knows what the turn was', () => {
    // The defect this closes: 30 of 31 acknowledgment-paired exchanges carried no intent at all.
    expect(closeOutAttribution(A_WHOLE_TURN)).toMatchObject({
      intent: 'financial_metric',
      intentConfidence: 'high',
      deliveryOption: 'PLACEHOLDER_UPDATE',
      taskId: 'task-9',
    });
  });

  it('declares nothing at all when the turn knows nothing, rather than an empty object', () => {
    // So a turn with nothing to say hands `updateMessage` exactly what it handed before, and the
    // only observable change is on the turns that have something.
    expect(closeOutAttribution({})).toBeUndefined();
  });
});

describe('what the close-out must NEVER carry', () => {
  /**
   * The allowlist is the contract, so this asserts the COMPLEMENT rather than a hand-written list of
   * forbidden keys. A list written out here goes stale the day a compute field is added; the
   * complement does not.
   */
  it('carries only the keys the module declares it may', () => {
    const carried = Object.keys(closeOutAttribution(A_WHOLE_TURN) ?? {});
    expect(carried.length).toBeGreaterThan(0);
    for (const key of carried) expect(CLOSE_OUT_ATTRIBUTION_KEYS).toContain(key);
  });

  it('cannot express the compute fields, which would double-count across two CREATE rows', () => {
    // model_usage, the Effectiveness cost estimate and every token sum read `messages` one row at a
    // time. Stamped on the receipt as well as on the answer, all of them would double - and only for
    // queued or privately answered turns, which is the population least likely to be reconciled.
    for (const forbidden of [
      'bedrockModel', 'model', 'inputTokens', 'outputTokens', 'latencyMs', 'totalMs',
      'imageCount', 'modelMs', 'toolMs',
    ]) {
      expect(CLOSE_OUT_ATTRIBUTION_KEYS).not.toContain(forbidden);
    }
  });

  it('cannot express a task transition or a task status, which would double a task ending', () => {
    // `task_transition` and a terminal `task_status` are what the ledger reads as `task_opened`,
    // `task_transition` and `task_terminal`. On a second row, one task movement is recorded twice
    // and `v_task_resolution` counts it twice. The bare id opens no ledger row.
    expect(CLOSE_OUT_ATTRIBUTION_KEYS).not.toContain('taskTransition');
    expect(CLOSE_OUT_ATTRIBUTION_KEYS).not.toContain('taskState');
    expect(CLOSE_OUT_ATTRIBUTION_KEYS).not.toContain('activeTask');
    expect(closeOutAttribution({ ...A_WHOLE_TURN } as Record<string, unknown>)).not.toHaveProperty('activeTask');
  });
});

describe('every branch that leaves a receipt behind carries it', () => {
  it('the close-out passes the attribution to the update it already performs', () => {
    // The two branches that set `acknowledgementMessageId`: a broadcast answer and a privately
    // targeted one. Both close out through this one helper, which is why there is one call site.
    expect(core).toContain('closeOutAttribution({');
    expect(core).toContain("import { closeOutAttribution } from './turn-attribution.js';");
  });

  it('the settled queue notice carries it too, because that is the other receipt', () => {
    // A turn whose placeholder became the notice answers in a new message at the end, so the
    // exchange is minted against the NOTICE. The settle is the update that notice already receives.
    expect(notice).toContain('attribution?: Record<string, unknown>;');
    expect(notice).toContain('...(args.attribution ?? {}),');
    expect(processor).toContain('...(event.triage ? {} : (() => {');
  });

  it('a READING never declares one, because it answers a burst and names no single message', () => {
    // It declares `turnKind: 'reading'` instead, and both pairers exclude a declared kind.
    expect(processor).toContain('...(event.triage ? {} : (() => {');
  });

  it('archival reads the bare task id the close-out carries, not only the activeTask blob', () => {
    expect(archival).toContain("|| (typeof analytics.taskId === 'string' ? analytics.taskId : null)");
  });
});
