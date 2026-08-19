/**
 * Channel Context Client — unit tests.
 *
 * Pins the server-only store contract: put writes ONLY the owned private grounding fields (never a
 * routing bit), get round-trips, and both fail soft. This is the store half of the P1 promise
 * (private host grounding lives server-side, not in member-readable channel Metadata).
 */
const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  UpdateCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
}), { virtual: true });

import { getChannelContext, getParticipantContext, putChannelContext } from '../../lambda/src/lib/channel-context-client';

const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';

beforeEach(() => {
  mockDdbSend.mockReset();
  process.env.CHANNEL_CONTEXT_TABLE = 'ChannelContextTest';
});

describe('channel-context-client', () => {
  it('put writes only the owned fields present (+ updatedAt); empty/undefined are skipped', async () => {
    mockDdbSend.mockResolvedValue({});
    await putChannelContext(ARN, {
      participantProfile: 'recruiter at Stratum',
      domainContext: { items: [1, 2] },
      otherContexts: undefined,
      userName: '',
    });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Update');
    expect(cmd.input.TableName).toBe('ChannelContextTest');
    expect(cmd.input.Key).toEqual({ channelArn: ARN });
    const vals = cmd.input.ExpressionAttributeValues;
    expect(vals[':participantProfile']).toBe('recruiter at Stratum');
    expect(vals[':domainContext']).toEqual({ items: [1, 2] });
    expect(vals[':updatedAt']).toEqual(expect.any(String));
    // empty string / undefined are not persisted
    expect(vals).not.toHaveProperty(':userName');
    expect(vals).not.toHaveProperty(':otherContexts');
    expect(cmd.input.UpdateExpression).toContain('#participantProfile = :participantProfile');
  });

  it('put ignores keys outside the owned set — a member-readable bit can never be persisted here', async () => {
    mockDdbSend.mockResolvedValue({});
    // Cast: the type forbids these keys; the runtime guard is what we are pinning. `topic` and
    // `contextType` stay in member-readable Metadata and have no business in this store.
    await putChannelContext(ARN, { participantProfile: 'x', topic: 'leaky', contextType: 'plan' } as never);
    const vals = mockDdbSend.mock.calls[0][0].input.ExpressionAttributeValues;
    expect(vals).not.toHaveProperty(':topic');
    expect(vals).not.toHaveProperty(':contextType');
    expect(vals[':participantProfile']).toBe('x');
  });

  // The routing signals ARE owned here, deliberately: they decide which model answers, and channel
  // Metadata is member-writable. A regression that dropped them from OWNED_FIELDS would discard them
  // silently, because putChannelContext only visits the owned keys and swallows write failures.
  it('put persists the model-routing signals, which this store owns', async () => {
    mockDdbSend.mockResolvedValue({});
    await putChannelContext(ARN, { userLanguage: 'zh', segment: { country: 'CN' } });
    const vals = mockDdbSend.mock.calls[0][0].input.ExpressionAttributeValues;
    expect(vals[':userLanguage']).toBe('zh');
    expect(vals[':segment']).toEqual({ country: 'CN' });
  });

  it('put is a no-op (no send) when no owned field has a value', async () => {
    await putChannelContext(ARN, { userName: '' });
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  // A field must be CLEARABLE. Treating every "no value" form as "skip" made each field
  // write-once-then-permanent: an edited plan that dropped its domainContext kept serving the stale
  // one indefinitely, because every way of expressing the removal was discarded as nothing-to-write.
  it('put REMOVEs a field explicitly set to null (the clear signal)', async () => {
    mockDdbSend.mockResolvedValue({});
    await putChannelContext(ARN, { domainContext: null, participantProfile: 'kept' });
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.input.UpdateExpression).toContain('REMOVE #domainContext');
    expect(cmd.input.UpdateExpression).toContain('#participantProfile = :participantProfile');
    // A cleared field carries no value binding.
    expect(cmd.input.ExpressionAttributeValues).not.toHaveProperty(':domainContext');
    expect(cmd.input.ExpressionAttributeNames['#domainContext']).toBe('domainContext');
  });

  it('put sends a REMOVE-only update when the patch clears the sole field', async () => {
    mockDdbSend.mockResolvedValue({});
    await putChannelContext(ARN, { userName: null });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const expr = mockDdbSend.mock.calls[0][0].input.UpdateExpression;
    expect(expr).toContain('REMOVE #userName');
    expect(expr).toContain('#updatedAt = :updatedAt'); // the timestamp still advances
  });

  it('put no-ops without throwing when the table is unset', async () => {
    delete process.env.CHANNEL_CONTEXT_TABLE;
    await expect(putChannelContext(ARN, { participantProfile: 'x' })).resolves.toBeUndefined();
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('put swallows a store error (best-effort, never leaks)', async () => {
    mockDdbSend.mockRejectedValue(new Error('boom'));
    await expect(putChannelContext(ARN, { participantProfile: 'x' })).resolves.toBeUndefined();
  });

  it('get round-trips the stored item', async () => {
    mockDdbSend.mockResolvedValue({ Item: { channelArn: ARN, participantProfile: 'r', domainContext: { a: 1 } } });
    const ctx = await getChannelContext(ARN);
    expect(ctx?.participantProfile).toBe('r');
    expect(ctx?.domainContext).toEqual({ a: 1 });
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Get');
    expect(cmd.input.Key).toEqual({ channelArn: ARN });
  });

  it('get fails soft to null on a store error', async () => {
    mockDdbSend.mockRejectedValue(new Error('boom'));
    await expect(getChannelContext(ARN)).resolves.toBeNull();
  });

  it('get returns null (no send) when the table is unset', async () => {
    delete process.env.CHANNEL_CONTEXT_TABLE;
    await expect(getChannelContext(ARN)).resolves.toBeNull();
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

/**
 * Participant shape (SPEC-USER-PROFILE-AND-ONBOARDING §2).
 *
 * Two of these guard failures that would be COMPLETELY SILENT in production:
 *
 *  - a field missing from `OWNED_FIELDS` is discarded by the write loop, and `putChannelContext` swallows
 *    errors, so a forgotten entry looks exactly like a successful write. The welcome would then fall back to
 *    live membership forever and nobody would see an error.
 *  - the welcome reads this row moments after it was written, so a default (eventually consistent) read can
 *    miss a completed write. That would put back the very ambiguity the pre-creation ordering removes.
 */
describe('channel-context-client - participant shape', () => {
  const SINGLE = { focus: 'single' as const, humans: ['user-a'], subject: 'user-a' };

  it('put PERSISTS participants (guards the OWNED_FIELDS omission)', async () => {
    mockDdbSend.mockResolvedValue({});
    await putChannelContext(ARN, { participants: SINGLE });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.input.ExpressionAttributeValues[':participants']).toEqual(SINGLE);
    expect(cmd.input.UpdateExpression).toContain('#participants = :participants');
  });

  it('put still writes participants alongside the private grounding fields', async () => {
    mockDdbSend.mockResolvedValue({});
    await putChannelContext(ARN, { participants: SINGLE, participantProfile: 'recruiter' });
    const vals = mockDdbSend.mock.calls[0][0].input.ExpressionAttributeValues;
    expect(vals[':participants']).toEqual(SINGLE);
    expect(vals[':participantProfile']).toBe('recruiter');
  });

  it('getParticipantContext uses a STRONGLY CONSISTENT read', async () => {
    mockDdbSend.mockResolvedValue({ Item: { channelArn: ARN, participants: SINGLE } });
    await getParticipantContext(ARN);
    expect(mockDdbSend.mock.calls[0][0].input.ConsistentRead).toBe(true);
  });

  it('getChannelContext does NOT request a consistent read by default', async () => {
    // Per-turn callers read a long-settled row; paying for consistency on every turn buys nothing.
    mockDdbSend.mockResolvedValue({ Item: { channelArn: ARN } });
    await getChannelContext(ARN);
    expect(mockDdbSend.mock.calls[0][0].input.ConsistentRead).toBeUndefined();
  });

  it('getParticipantContext re-derives the shape rather than trusting the stored triple', async () => {
    mockDdbSend.mockResolvedValue({
      Item: { channelArn: ARN, participants: { focus: 'single', humans: ['a', 'b'], subject: 'a' } },
    });
    await expect(getParticipantContext(ARN)).resolves.toEqual({
      focus: 'group', humans: ['a', 'b'], subject: '',
    });
  });

  it('getParticipantContext returns null when nothing was recorded, NOT a fabricated `none`', async () => {
    // Null tells the caller to fall back to live membership. A fabricated `none` would instead assert that
    // the conversation has no humans, silently disabling onboarding on every legacy channel.
    mockDdbSend.mockResolvedValue({ Item: { channelArn: ARN, participantProfile: 'r' } });
    await expect(getParticipantContext(ARN)).resolves.toBeNull();
  });

  it('getParticipantContext fails soft to null on a store error', async () => {
    mockDdbSend.mockRejectedValue(new Error('boom'));
    await expect(getParticipantContext(ARN)).resolves.toBeNull();
  });
});
