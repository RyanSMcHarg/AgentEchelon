/**
 * AN ASSISTANT HANDLE WITH NO LIVE ASSISTANT IS A REFUSAL, NOT A SMALLER CONVERSATION.
 *
 * A conversation type names its assistants by handle, and the second one it names exists only where the
 * deployment declares its role (`ops-premium` in `profiles`). The tolerant answer - add whoever resolved, log
 * the rest - delivers an `ops` conversation containing one assistant: correctly named, correctly
 * populated with people, answering normally, and missing the thing it was created for. Nobody reads a
 * log to find that out, which is why the resolver throws.
 */
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParametersByPathCommand: jest.fn((input: unknown) => ({ __type: 'ByPath', input })),
}), { virtual: true });

import { resolveDefaultAgents, __resetAssistantCacheForTests } from '../../lambda/src/lib/default-agents';

/** One assignment record as the stacks publish it. */
const record = (over: Record<string, unknown> = {}) => ({
  Value: JSON.stringify({
    classification: 'premium',
    role: 'primary',
    occupancy: 'live',
    assistant: 'advisor',
    botArn: 'arn:aws:chime:us-east-1:1:app-instance/app/bot/advisor',
    roleArn: 'arn:aws:iam::1:role/slot',
    ...over,
  }),
});

const opsRecord = record({ role: 'ops', assistant: 'ops-premium', botArn: 'arn:…/bot/ops-premium' });

beforeEach(() => {
  jest.clearAllMocks();
  // THE CACHE IS PER CONTAINER AND SURVIVES A TEST, which is the point of it in production and a trap
  // here: without this reset the first case populates `premium` and every later one reads those records
  // instead of the ones it just mocked. Four assertions in this file were passing against data they never
  // supplied until this line existed.
  __resetAssistantCacheForTests();
});

describe('resolving the handles a type names', () => {
  it('resolves each handle to the bot ARN its live assignment record publishes', async () => {
    mockSsmSend.mockResolvedValue({ Parameters: [record(), opsRecord] });
    const resolved = await resolveDefaultAgents('premium', ['advisor', 'ops-premium']);
    expect(resolved.map((r) => r.handle)).toEqual(['advisor', 'ops-premium']);
    expect(resolved[1].role).toBe('ops');
  });

  it('preserves the order the TYPE declared, not the order SSM enumerated', async () => {
    // The log line and the notification name the assistants, and a roster that reorders itself per
    // deployment reads as a different conversation each time.
    mockSsmSend.mockResolvedValue({ Parameters: [opsRecord, record()] });
    const resolved = await resolveDefaultAgents('premium', ['advisor', 'ops-premium']);
    expect(resolved.map((r) => r.handle)).toEqual(['advisor', 'ops-premium']);
  });

  it('THROWS when a handle has no live assistant, naming what it did and did not find', async () => {
    // The state of a deployment without the extra role. The error has to distinguish "the role was not
    // built" from "the handle is misspelled in the registry", because from the outside they are identical.
    mockSsmSend.mockResolvedValue({ Parameters: [record()] });
    await expect(resolveDefaultAgents('premium', ['advisor', 'ops-premium']))
      .rejects.toThrow(/ops-premium/);
    await expect(resolveDefaultAgents('premium', ['advisor', 'ops-premium']))
      .rejects.toThrow(/declares it: its assistant named in profiles/);
  });

  it('never adds an ALT, however well its name reads', async () => {
    // The alt is the challenger a duel arms and is empty between battles. A conversation given one
    // would be held by an assistant that exists only while an experiment is running.
    mockSsmSend.mockResolvedValue({
      Parameters: [record(), record({ role: 'ops', assistant: 'ops-premium', occupancy: 'alt' })],
    });
    await expect(resolveDefaultAgents('premium', ['ops-premium'])).rejects.toThrow(/ops-premium/);
  });

  it('reads only its own classification\'s subtree', async () => {
    // `(premium, ops)` and `(standard, ops)` are different role instances with different scopes. A
    // resolver that searched both could add the wrong one, and the IAM grant is scoped the same way.
    mockSsmSend.mockResolvedValue({ Parameters: [record()] });
    await resolveDefaultAgents('premium', ['advisor']);
    const path = (mockSsmSend.mock.calls[0][0] as { input: { Path: string } }).input.Path;
    expect(path).toMatch(/assistant-assignments\/premium$/);
  });

  it('pages, because a classification\'s assignment records are not bounded by one page', async () => {
    // `GetParametersByPath` returns ten by default and each role publishes two records, so four roles
    // already truncate. A handle that fell off the end would turn into the refusal above - a creation
    // failing for a reason nowhere in the payload.
    mockSsmSend
      .mockResolvedValueOnce({ Parameters: [record()], NextToken: 'more' })
      .mockResolvedValueOnce({ Parameters: [opsRecord] });
    const resolved = await resolveDefaultAgents('premium', ['advisor', 'ops-premium']);
    expect(resolved).toHaveLength(2);
    expect(mockSsmSend).toHaveBeenCalledTimes(2);
  });

  it('asks SSM nothing when the type names no assistants', async () => {
    // Most types name none, and the per-classification primary is a member by creation. A read on every
    // creation for a list that is almost always empty is a round trip for nothing.
    expect(await resolveDefaultAgents('premium', [])).toEqual([]);
    expect(mockSsmSend).not.toHaveBeenCalled();
  });

  it('skips a record it cannot parse rather than guessing at it', async () => {
    // A malformed record then fails to resolve its handle, which is the refusal with a name in it.
    mockSsmSend.mockResolvedValue({ Parameters: [{ Value: 'not json' }, record()] });
    const resolved = await resolveDefaultAgents('premium', ['advisor']);
    expect(resolved.map((r) => r.handle)).toEqual(['advisor']);
  });
});
