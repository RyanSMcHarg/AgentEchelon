/**
 * The task kinds have a producer.
 *
 * `v_task_resolution` aggregates `task_opened`, `task_transition` and `task_terminal` and NOTHING
 * emitted any of them: measured live, the deployed query returned zero rows over a 47-day window with
 * substantial task traffic. An empty view reads as "no task resolved in this window", which is a claim
 * about the product; the truth was "this was never measured", which is a claim about the pipeline.
 *
 * The events already existed one layer up - the archive record carries `task_transition` and
 * `task_status` per turn - so this is a projection, not a new measurement. These tests pin the
 * projection AND the property that made it necessary to change the ledger's unique key: one archived
 * event can now legitimately produce two rows, and under the old key the second was silently dropped.
 */
import { ledgerRowsFor, terminalKindFor, type LedgerSourceRecord } from '../../lambda/src/analytics-aurora/turn-events-live';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/default';
const USER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1';

const record = (over: Partial<LedgerSourceRecord> = {}): LedgerSourceRecord => ({
  event_type: 'CREATE_CHANNEL_MESSAGE',
  message_id: 'm1',
  channel_arn: CHANNEL,
  sender_arn: BOT,
  is_bot: true,
  created_at: '2026-08-17T10:00:00.000Z',
  last_updated_at: null,
  resp_phase: null,
  content: 'One moment... <!--corr:abc123def4567890-->',
  task_id: null,
  task_state: null,
  task_status: null,
  task_transition: null,
  ...over,
});

const kinds = (rows: Array<{ kind: string }>) => rows.map((r) => r.kind);

describe('a record with no task is untouched', () => {
  it('emits exactly what it emitted before - the projection is inert without a task', () => {
    const rows = ledgerRowsFor([record()]);
    expect(kinds(rows)).toEqual(['placeholder_posted']);
  });

  it('a task_id alone is not an event: nothing happened to the task on this turn', () => {
    // Emitting `task_opened` for every turn that merely MENTIONS a task would make opened_at the last
    // turn rather than the first, and resolve_ms would collapse toward zero on every task.
    const rows = ledgerRowsFor([record({ task_id: 't1', task_state: 'drafting_outline' })]);
    expect(kinds(rows)).toEqual(['placeholder_posted']);
  });
});

describe('the three kinds, each from a signal the product already declares', () => {
  it('an edge with no `from` opens the task', () => {
    const rows = ledgerRowsFor([record({
      task_id: 't1',
      task_state: 'collecting_requirements',
      task_transition: { from: '', to: 'collecting_requirements' },
    })]);
    expect(kinds(rows)).toEqual(['placeholder_posted', 'task_opened']);
    expect(rows.find((r) => r.kind === 'task_opened')?.task_id).toBe('t1');
  });

  it('an edge between two states is a transition, not a second opening', () => {
    const rows = ledgerRowsFor([record({
      task_id: 't1',
      task_state: 'generating',
      task_transition: { from: 'drafting_outline', to: 'generating' },
    })]);
    expect(kinds(rows)).toEqual(['placeholder_posted', 'task_transition']);
  });

  it('a terminal lifecycle status ends it, and records HOW', () => {
    const rows = ledgerRowsFor([record({
      event_type: 'UPDATE_CHANNEL_MESSAGE',
      last_updated_at: '2026-08-17T10:05:00.000Z',
      resp_phase: 'final',
      task_id: 't1',
      task_status: 'completed',
    })]);
    expect(kinds(rows)).toEqual(['final_response', 'task_terminal']);
    const terminal = rows.find((r) => r.kind === 'task_terminal');
    expect(terminal?.terminal_kind).toBe('success');
    // Dated to the UPDATE, not to when the placeholder was posted - resolve_ms is measured between
    // these instants, so dating the close to the open reports every task as instantaneous.
    expect(terminal?.occurred_at).toBe('2026-08-17T10:05:00.000Z');
  });

  it('ends a task exactly when the PRODUCT ends one - the map is imported, not copied', () => {
    // The ledger's own hand-written map once said abandoned -> 'expired' while task-tracking
    // deliberately keeps 'abandoned' ACTIVE ("the person may come back", and a nudge can offer to
    // resume it) - so the ledger recorded an ending for a task the product still treats as
    // resumable, and v_task_resolution disagreed with the task record. terminalKindFor now reads
    // TERMINAL_TASK_STATUS itself, so the two cannot diverge again; 'expired' stays a legal schema
    // kind for the day the product makes abandonment terminal, and nothing emits it until then.
    expect(terminalKindFor('completed')).toBe('success');
    expect(terminalKindFor('failed')).toBe('failure');
    expect(terminalKindFor('cancelled')).toBe('handoff');
    expect(terminalKindFor('abandoned')).toBeNull();
  });

  it('an ACTIVE status is not an ending', () => {
    for (const status of ['pending', 'in_progress', 'abandoned', null, undefined, 'nonsense']) {
      expect(terminalKindFor(status)).toBeNull();
    }
  });
});

describe('one event, two rows - the reason the ledger key changed', () => {
  it('the turn that opens a task posts a placeholder AND opens the task, at the same instant', () => {
    const rows = ledgerRowsFor([record({
      task_id: 't1',
      task_transition: { from: '', to: 'collecting_requirements' },
    })]);
    expect(rows).toHaveLength(2);
    // Same message, same event type, same instant. Under the pre-024 unique key
    // (source_message_id, source_event_type, occurred_at) the second row is discarded by
    // ON CONFLICT DO NOTHING - the write succeeds, the count looks plausible, and the task event is
    // simply absent. That is why `kind` is part of the key now.
    expect(new Set(rows.map((r) => r.source_message_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.source_event_type)).size).toBe(1);
    expect(new Set(rows.map((r) => r.occurred_at)).size).toBe(1);
    expect(new Set(rows.map((r) => r.kind)).size).toBe(2);
  });

  it('a turn can both transition and terminate a task', () => {
    const rows = ledgerRowsFor([record({
      event_type: 'UPDATE_CHANNEL_MESSAGE',
      last_updated_at: '2026-08-17T10:05:00.000Z',
      resp_phase: 'final',
      task_id: 't1',
      task_status: 'completed',
      task_transition: { from: 'generating', to: 'delivered' },
    })]);
    expect(kinds(rows)).toEqual(['final_response', 'task_transition', 'task_terminal']);
  });
});

describe('the task rows carry the turn they belong to', () => {
  it('takes the declared turn id from the message, so the view can count turns per task', () => {
    const rows = ledgerRowsFor([record({
      task_id: 't1',
      task_transition: { from: 'a', to: 'b' },
    })]);
    const transition = rows.find((r) => r.kind === 'task_transition');
    expect(transition?.turn_id).toBe('abc123def4567890');
  });

  it('a user message with a task still names the actor and the channel', () => {
    const rows = ledgerRowsFor([record({
      is_bot: false,
      sender_arn: USER,
      content: 'here is the scope',
      task_id: 't1',
      task_transition: { from: 'collecting_requirements', to: 'drafting_outline' },
    })]);
    const transition = rows.find((r) => r.kind === 'task_transition');
    expect(transition?.actor).toBe(USER);
    expect(transition?.channel_arn).toBe(CHANNEL);
  });
});

describe('the open edge has a PRODUCER (found live 2026-08-18 by task-resolution e2e)', () => {
  // The fixtures above synthesize `task_transition: { from: '', to: ... }` - and for two days nothing
  // in production emitted a from-less edge: task CREATION fires no machine transition, so taskTransition
  // stayed undefined on the creation turn, task_opened never fired, and v_task_resolution.opened_at was
  // NULL on a live deployment while every test here passed. The bound was satisfied by the test data
  // and violated by the real data - the same failure family this file's own row documents. These pin
  // the producer chain: the router DECLARES creation, and the worker turns it into the open edge.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const read = (rel: string): string => {
    const raw = fs.readFileSync(path.join(__dirname, '../../lambda/src', rel), 'utf8');
    // Strip line comments so prose mentioning the symbols cannot satisfy the assertions.
    return raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  };

  it('the router declares taskCreated on BOTH create branches and ships it to the worker', () => {
    const router = read('router-agent-handler.ts');
    expect((router.match(/taskCreated = true;/g) || []).length).toBe(2);
    expect(router).toMatch(/taskId,\s*taskType,\s*taskCreated,/);
  });

  it('the worker turns the declaration into the from-less open edge', () => {
    const core = read('lib/async-processor-core.ts');
    expect(core).toMatch(/event\.taskCreated \? '' : taskTx\[0\]\.from/);
    expect(core).toMatch(/event\.taskCreated && params\.taskContext\?\.task\.taskState/);
  });
});

describe('the open edge SURVIVES archival (the third inert link, found live 2026-08-18)', () => {
  // The producer fix alone was not enough: archival's truthiness check (`.from && .to`) dropped the
  // edge whose EMPTY `from` is its meaning, so the declaration died between the worker and the
  // column. Asserted end-of-chain: the archived record carries { from: '', to } intact.
  const { transformToMessageRecord } = require('../../lambda/src/analytics-aurora/kinesis-archival');
  const CH = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c-open-edge';

  const botMessage = (taskTransition: unknown) => ({
    EventType: 'CREATE_CHANNEL_MESSAGE',
    Payload: {
      ChannelArn: CH,
      MessageId: 'm-open-edge-1',
      Content: 'One moment... <!--corr:abc123def4567890-->',
      Sender: { Arn: 'a/bot/b1', Name: 'Assistant' },
      CreatedTimestamp: '2026-08-18T00:00:00Z',
      Metadata: JSON.stringify({
        analytics: { taskState: 'collecting_requirements', taskTransition, activeTask: { taskId: 't-open', status: 'pending' } },
      }),
      ChannelFlow: undefined,
    },
  });

  it('an empty `from` is preserved, not dropped', async () => {
    const rec = await transformToMessageRecord(botMessage({ from: '', to: 'collecting_requirements' }) as any);
    expect(rec).not.toBeNull();
    expect(rec!.task_transition).toEqual({ from: '', to: 'collecting_requirements' });
  });

  it('and the projection then opens the task from that archived record', async () => {
    const rec = await transformToMessageRecord(botMessage({ from: '', to: 'collecting_requirements' }) as any);
    const rows = ledgerRowsFor([{ ...(rec as any), task_id: 't-open', is_bot: true } as LedgerSourceRecord]);
    expect(rows.some((r) => r.kind === 'task_opened' && r.task_id === 't-open')).toBe(true);
  });

  it('an absent transition still archives as null (no phantom edges)', async () => {
    const rec = await transformToMessageRecord(botMessage(undefined) as any);
    expect(rec!.task_transition).toBeNull();
  });
});
