/**
 * EVERY READER OF A TASK'S ENDING READS ONE RULE: the machine's own (`machineTerminalKind`).
 *
 * A task turn records the state its task ended in as `task_status`, and a machine names its own endings:
 * `image_generation` succeeds in `done`, a report in `completed`. The experiment rollup learned that
 * (`successTerminalStates`), while the turn-events ledger mapped `task_status` through the lifecycle table only and the
 * Quality > Tasks metrics counted the literal `completed`, so an image task that finished had an ending in one reader
 * and none in the other two.
 *
 * WHAT THIS PINS:
 *   - one helper in `task-state-machines.ts`, which the rollup, the task metrics and the ledger all read;
 *   - the ledger records `task_terminal` for a machine's success state, and still none for a state that is not an ending;
 *   - a machine only a deployment pack declares reaches the ledger through the ending the turn's runtime declares from
 *     its pack-merged machines (`taskTerminal`), because the archive holds no pack.
 */
const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  batchInsert: jest.fn(async () => 0),
  transaction: jest.fn(),
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
  getClient: jest.fn(),
}));
const mockReadAnalytics = jest.fn();
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: (...args: unknown[]) => mockReadAnalytics(...args),
  writeMessageAnalytics: jest.fn(async () => undefined),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({ detectDrift: jest.fn(), recordDriftFire: jest.fn() }));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({ updateConversationContext: jest.fn() }));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({ touchActivity: jest.fn() }));

import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { machineTerminalKind, successTerminalStates, DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { successTerminalStates as rollupSuccessStates, handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { ledgerRowsFor, terminalKindFor, type LedgerSourceRecord } from '../../lambda/src/analytics-aurora/turn-events-live';
import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { buildAnalyticsMetadata } from '../../lambda/src/lib/analytics-metadata';
import { analyticsPathFor } from '../helpers/analytics-path';
import { edgeContext } from '../helpers/edge-context';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** A machine only a deployment's pack declares; the platform set does not know it. */
const PACK_ONLY = {
  triage: { initial: 'open', states: { open: { transitions: ['settled', 'lost'] }, settled: { transitions: [], terminal: 'success' }, lost: { transitions: [], terminal: 'failure' } } },
} as never;

describe('one rule, in one place', () => {
  it('names a machine ending by the kind its definition gives it, and nothing else an ending', () => {
    expect(machineTerminalKind('image_generation', 'done')).toBe('success');
    expect(machineTerminalKind('report_generation', 'completed')).toBe('success');
    expect(machineTerminalKind('image_generation', DEFAULT_TASK_STATE_MACHINES.image_generation.initial)).toBeNull();
    expect(machineTerminalKind('no_such_type', 'done')).toBeNull();
    expect(machineTerminalKind('triage', 'settled')).toBeNull();
    expect(machineTerminalKind('triage', 'settled', PACK_ONLY)).toBe('success');
  });

  it('is the list the experiment rollup and the task metrics match on', () => {
    expect(rollupSuccessStates).toBe(successTerminalStates);
    for (const entry of successTerminalStates()) {
      const [type, state] = entry.split(':');
      expect(machineTerminalKind(type, state)).toBe('success');
    }
    // No second copy of the rule in the query module.
    expect(read('lambda/src/analytics-aurora/analytics-query.ts')).not.toMatch(/function successTerminalStates/);
  });
});

describe('the turn-events ledger records a machine ending', () => {
  const record = (over: Partial<LedgerSourceRecord>): LedgerSourceRecord => ({
    event_type: 'UPDATE_CHANNEL_MESSAGE', message_id: 'm1-UPD', channel_arn: 'arn:ch', sender_arn: 'arn:bot', is_bot: true,
    created_at: '2026-10-30T10:00:00.000Z', last_updated_at: '2026-10-30T10:00:05.000Z', resp_phase: 'final',
    content: 'Here is your image.', task_id: 't-1', task_state: null, task_status: null, task_transition: null, ...over,
  });
  const terminals = (r: LedgerSourceRecord) => ledgerRowsFor([r]).filter((x) => x.kind === 'task_terminal');

  it('as success when the task ended in its machine success state', () => {
    expect(terminalKindFor('done', 'image_generation')).toBe('success');
    const rows = terminals(record({ task_status: 'done', task_type: 'image_generation' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ terminal_kind: 'success' });
  });

  it('as nothing when the state is not an ending, and the lifecycle table still decides its own statuses', () => {
    expect(terminals(record({ task_status: DEFAULT_TASK_STATE_MACHINES.image_generation.initial, task_type: 'image_generation' }))).toHaveLength(0);
    expect(terminalKindFor('completed')).toBe('success');
    expect(terminalKindFor('abandoned', 'image_generation')).toBeNull();
  });

  it('from the ending the runtime declared, for a machine only its pack declares', () => {
    // The archive has the platform machines only, so without the declaration this ending is unknown to it.
    expect(terminalKindFor('settled', 'triage')).toBeNull();
    expect(terminalKindFor('settled', 'triage', 'success')).toBe('success');
    expect(terminals(record({ task_status: 'settled', task_type: 'triage', task_terminal: 'success' }))).toHaveLength(1);
    // A declaration that is not a terminal kind is not an ending.
    expect(terminalKindFor('settled', 'triage', 'finished')).toBeNull();
  });
});

describe('the declaration travels from the runtime to the ledger', () => {
  it('is read against the pack-merged machines the processor holds', () => {
    const core = flat(read('lambda/src/lib/async-processor-core.ts'));
    expect(core).toContain('taskTerminal: machineTerminalKind( activeTaskInfo?.type ?? event.taskType, params.taskContext?.task.taskState, taskStateMachines(), ) ?? undefined,');
    expect(core).toContain('...(taskAnalytics.taskTerminal && { taskTerminal: taskAnalytics.taskTerminal }),');
  });

  it('rides the analytics record, and the archive hands it to the ledger beside the task type', async () => {
    expect(buildAnalyticsMetadata({ messageNumber: 2, role: 'assistant', taskTerminal: 'success' }).taskTerminal).toBe('success');
    mockReadAnalytics.mockResolvedValue({ activeTask: { type: 'triage', status: 'settled' }, taskTerminal: 'success' });
    const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
    const rec = await transformToMessageRecord({
      EventType: 'UPDATE_CHANNEL_MESSAGE',
      Payload: {
        MessageId: 'm-1', ChannelArn: `${APP}/channel/c1`, Content: 'Settled.', Sender: { Arn: `${APP}/bot/advisor`, Name: 'Advisor' },
        CreatedTimestamp: '2026-10-30T10:00:00.000Z', LastUpdatedTimestamp: '2026-10-30T10:00:05.000Z', Persistence: 'PERSISTENT',
        Metadata: JSON.stringify({ respPhase: 'final' }),
      },
    } as never);
    expect(rec).toMatchObject({ task_status: 'settled', task_type: 'triage', task_terminal: 'success' });
    const archival = flat(read('lambda/src/analytics-aurora/kinesis-archival.ts'));
    expect(archival).toContain('task_type: r.task_type, task_terminal: r.task_terminal ?? null,');
  });
});

describe('Quality > Tasks counts a machine success state as completed', () => {
  it('matches the same list the experiment rollup does', async () => {
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [] });
    const body = { queryType: 'task_metrics', dateRange: { start: '2026-10-29', end: '2026-10-30' } };
    const res = await handler({
      httpMethod: 'POST', path: analyticsPathFor(body), body: JSON.stringify(body),
      requestContext: { authorizer: edgeContext({ claims: { sub: 'admin', 'cognito:groups': 'admins' } }) },
    } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(200);
    const call = mockDbQuery.mock.calls.find(([sql]) => /AS completed/.test(String(sql)));
    expect(call).toBeDefined();
    const [sql, params] = call as [string, unknown[]];
    expect(flat(sql)).toContain("FILTER (WHERE (task_status = 'completed' OR (task_type || ':' || task_status) = ANY($2::text[]))) AS completed");
    expect(params[1]).toEqual(successTerminalStates());
  });
});
