/**
 * A SUBJECT MOVED TO ANOTHER CONVERSATION LEAVES THE ORIGINAL ONE'S SUMMARY.
 *
 * The running summary is added to every turn's prompt and is what drift compares against, so a moved subject
 * left in it stays in the conversation for good. The transcript is built without the moved exchange; the summary
 * before it is still carried (it holds everything older), and the model is told which request moved, to drop its subject.
 */
import type { QueryResult, QueryResultRow } from 'pg';

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn(), getClient: jest.fn(), ensureSchema: jest.fn() }));
const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args: unknown) => ({ __args: args })),
}));
jest.mock('../../lambda/src/analytics-aurora/embedding-writer', () => ({ writeSummaryEmbedding: jest.fn() }));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { withTurnDeclaration } from '../../lambda/src/lib/turn-declaration';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const rows = <T extends QueryResultRow>(r: T[]) => ({ rows: r, rowCount: r.length, command: '', oid: 0, fields: [] as never }) as QueryResult<T>;
const CHANNEL_ARN = 'arn:aws:chime:us-east-1:1:app-instance/test/channel/c1';

/** Newest first, as the transcript query returns it. */
function transcript(moved: boolean) {
  const all = [
    { message_id: 'm1', sender_name: 'alice', is_bot: false, content: 'How does AgentEchelon route a turn?' },
    { message_id: 'm2', sender_name: null, is_bot: true, content: 'AgentEchelon routes each turn through the router.' },
    { message_id: 'm3', sender_name: 'alice', is_bot: false, content: 'What is our revenue pipeline for Q3?' },
    { message_id: 'm5', sender_name: null, is_bot: true, content: withTurnDeclaration('Reply yes to move it.', { kind: 'drift', answers: 'm3' }) },
    { message_id: 'm4', sender_name: 'alice', is_bot: false, content: 'yes' },
    ...(moved ? [{ message_id: 'm6', sender_name: null, is_bot: true, content: withTurnDeclaration('Created a new conversation.', { kind: 'drift', moves: 'm3', answers: 'm4' }) }] : []),
  ];
  return all.map((m, i) => ({ ...m, created_at: `2026-11-04T10:0${i}:00Z` })).reverse();
}

function run(moved: boolean) {
  mockedQuery
    .mockResolvedValueOnce(rows([{ channel_arn: CHANNEL_ARN, current_version: 2, last_summary_at: '2026-11-04T10:03:00Z', newest_message_at: '2026-11-04T10:05:00Z' }]))
    .mockResolvedValueOnce(rows(transcript(moved)))
    // The summary written when the moved message arrived, before the yes.
    .mockResolvedValueOnce(rows([{ version: 2, summary: 'AgentEchelon routing and the Q3 revenue pipeline', purpose: 'p', topics: ['revenue pipeline'], generated_by: 'summary-updater' }]));
  mockBedrockSend.mockRejectedValueOnce(new Error('stop after the prompt (simulated)'));
}

function prompt(): string {
  return mockBedrockSend.mock.calls.map(([cmd]) => String((cmd as { __args?: { body?: string } })?.__args?.body ?? '')).join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DB_HOST = 'localhost';
  process.env.DB_NAME = 'analytics';
  process.env.DB_USER = 'u';
  process.env.DB_REGION = 'us-east-1';
});

describe('the summary after a move', () => {
  const quiet = () => {
    const w = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const l = jest.spyOn(console, 'log').mockImplementation(() => {});
    return () => { w.mockRestore(); l.mockRestore(); };
  };

  it('keeps the whole conversation: the summary before the move is carried, the moved exchange is left out of the transcript, and the moved request is named for the model to drop', async () => {
    run(true);
    const restore = quiet();
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    await handler();
    restore();
    const p = prompt();
    const transcriptBlock = p.slice(p.indexOf('<transcript>'), p.indexOf('</transcript>'));
    expect(transcriptBlock).toContain('How does AgentEchelon route a turn?');
    expect(transcriptBlock).not.toMatch(/revenue pipeline/i);
    expect(transcriptBlock).not.toContain('Reply yes to move it.');
    expect(transcriptBlock).not.toContain('Created a new conversation.');
    // Everything older than the window lives in the previous summary, so it is carried, never rebuilt from the window alone.
    expect(p).toContain('<previous_summary>');
    expect(p).toContain('AgentEchelon routing');
    // The moved request, as data, with the instruction to leave its subject out.
    const movedBlock = p.slice(p.indexOf('<moved_requests>'), p.indexOf('</moved_requests>'));
    expect(movedBlock).toContain('What is our revenue pipeline for Q3?');
    expect(p).toMatch(/Leave that subject out of the summary, the purpose and the topics/);
  });

  it('keeps a declined subject, which is a subject of this conversation', async () => {
    run(false);
    const restore = quiet();
    const { handler } = await import('../../lambda/src/analytics-aurora/summary-updater');
    await handler();
    restore();
    expect(prompt()).toContain('What is our revenue pipeline for Q3?');
  });

  it('selects the message id the declarations name', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src/analytics-aurora/summary-updater.ts'), 'utf8');
    expect(src).toContain('`SELECT message_id, sender_name, is_bot, content, created_at');
  });
});
