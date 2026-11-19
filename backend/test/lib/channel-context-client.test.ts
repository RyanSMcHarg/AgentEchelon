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

import { getChannelContext, getParticipantContext, putChannelContext, advanceOnboardingIntake, recordChildConversation, claimActiveMeeting, releaseActiveMeeting } from '../../lambda/src/lib/channel-context-client';

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
    // Cast: the type forbids these keys; the runtime guard is what we are pinning. `createdBy` and
    // `contextType` stay in member-readable Metadata and have no business in this store.
    //
    // THIS TEST USED `topic` AS ITS EXAMPLE, AND `topic` IS NOW OWNED HERE - a deliberate reversal, not
    // a weakening of this guard. The rule the store enforces is not "no member-authored text": the
    // store already owns `priorSubject`, which is also the member's own words. It is "server-written,
    // and readable when it has to be read". `topic`'s only reader is `WelcomeIntent`, which fires on
    // the assistant's automatic membership at creation - the moment channel Metadata is least reliably
    // readable - so a Metadata-only `topic` lost the welcome's grounding intermittently. It is written
    // to BOTH now: this copy for the read, and Metadata so a member can still edit their own subject.
    await putChannelContext(ARN, { participantProfile: 'x', createdBy: 'leaky', contextType: 'plan' } as never);
    const vals = mockDdbSend.mock.calls[0][0].input.ExpressionAttributeValues;
    expect(vals).not.toHaveProperty(':createdBy');
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
    await expect(putChannelContext(ARN, { participantProfile: 'x' })).resolves.toBe(false);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it('put swallows a store error (best-effort, never leaks)', async () => {
    mockDdbSend.mockRejectedValue(new Error('boom'));
    await expect(putChannelContext(ARN, { participantProfile: 'x' })).resolves.toBe(false);
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

// AN INTAKE IS ADVANCED ONLY FROM THE STATE THAT WAS READ (code review, 2026-09-12). Two deliveries of one
// answer each read the same state; an unconditional write let the second file the answer under the next
// question.
describe('advanceOnboardingIntake', () => {
  const next = { subject: 'alice', cursor: 1, collected: { company: 'Acme' }, phase: 'collecting' as const };

  it('writes conditionally on the cursor, phase and subject it advanced from', async () => {
    mockDdbSend.mockResolvedValue({});

    expect(await advanceOnboardingIntake(ARN, { cursor: 0, phase: 'collecting', subject: 'alice' }, next)).toBe('advanced');

    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.input.ConditionExpression).toBe('#intake.#cursor = :cursor AND #intake.#phase = :phase AND #intake.#subject = :subject');
    expect(cmd.input.ExpressionAttributeValues).toEqual(expect.objectContaining({
      ':cursor': 0, ':phase': 'collecting', ':subject': 'alice', ':next': next,
    }));
  });

  it('reports a lost race rather than overwriting the turn that won it', async () => {
    mockDdbSend.mockRejectedValue(Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' }));
    expect(await advanceOnboardingIntake(ARN, { cursor: 0, phase: 'collecting', subject: 'alice' }, next)).toBe('lost');
  });

  it('reports a store failure as failed, not as lost', async () => {
    mockDdbSend.mockRejectedValue(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));
    expect(await advanceOnboardingIntake(ARN, { cursor: 0, phase: 'collecting', subject: 'alice' }, next)).toBe('failed');
  });
});

describe('putChannelContext reports whether it wrote', () => {
  it('true on a write, false when the store refused it', async () => {
    mockDdbSend.mockResolvedValueOnce({});
    expect(await putChannelContext(ARN, { userName: 'Alice' })).toBe(true);
    mockDdbSend.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ResourceNotFoundException' }));
    expect(await putChannelContext(ARN, { userName: 'Alice' })).toBe(false);
  });
});

describe('a conversation is created once and enrolled once (ADR-050)', () => {
  it('writes createdAt and enrollment only where absent, so a re-stamp keeps the first value', async () => {
    mockDdbSend.mockResolvedValue({});
    await putChannelContext(ARN, {
      createdAt: '2026-10-12T00:00:00.000Z',
      enrollment: { experimentId: 'e1', variantId: 'treatment' },
      userName: 'Alice',
    });
    const expr = mockDdbSend.mock.calls[0][0].input.UpdateExpression as string;
    expect(expr).toContain('#createdAt = if_not_exists(#createdAt, :createdAt)');
    expect(expr).toContain('#enrollment = if_not_exists(#enrollment, :enrollment)');
    expect(expr).toContain('#userName = :userName');
  });
});

describe('recordChildConversation', () => {
  const PARENT = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/team';
  const child = { channelId: 'esc-new', typeKey: 'ops', openedAt: '2026-11-08T00:00:00Z' };
  const full = Array.from({ length: 50 }, (_, i) => ({ channelId: `esc-${i}`, typeKey: 'ops', openedAt: '2026-11-07T00:00:00Z' }));
  const raced = [...full.slice(1), { channelId: 'esc-other', typeKey: 'ops', openedAt: '2026-11-07T12:00:00Z' }];
  const failed = () => Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });

  it('under the cap, appends on a size condition and reads nothing', async () => {
    mockDdbSend.mockResolvedValue({});
    await expect(recordChildConversation(PARENT, child)).resolves.toBe(true);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Update');
    expect(cmd.input.UpdateExpression).toContain('list_append');
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(#children) OR size(#children) < :cap');
    expect(cmd.input.ExpressionAttributeValues[':cap']).toBe(50);
  });

  it('at the cap, replaces the list on the condition that it is exactly the list it read, oldest dropped', async () => {
    mockDdbSend.mockRejectedValueOnce(failed()).mockResolvedValueOnce({ Item: { children: full } }).mockResolvedValueOnce({});
    await expect(recordChildConversation(PARENT, child)).resolves.toBe(true);
    const [, get, replace] = mockDdbSend.mock.calls.map((c) => c[0]);
    expect(get.__type).toBe('Get');
    expect(get.input.ConsistentRead).toBe(true);
    expect(replace.input.ConditionExpression).toBe('#children = :read');
    expect(replace.input.ExpressionAttributeValues[':read']).toEqual(full);
    expect(replace.input.ExpressionAttributeValues[':list']).toEqual([...full.slice(1), child]);
  });

  it('DENY: a replace raced by another child never overwrites it; it reads again and keeps both', async () => {
    mockDdbSend
      .mockRejectedValueOnce(failed())
      .mockResolvedValueOnce({ Item: { children: full } }).mockRejectedValueOnce(failed())
      .mockResolvedValueOnce({ Item: { children: raced } }).mockResolvedValueOnce({});
    await expect(recordChildConversation(PARENT, child)).resolves.toBe(true);
    const last = mockDdbSend.mock.calls[4][0];
    expect(last.input.ExpressionAttributeValues[':read']).toEqual(raced);
    expect(last.input.ExpressionAttributeValues[':list']).toContainEqual({ channelId: 'esc-other', typeKey: 'ops', openedAt: '2026-11-07T12:00:00Z' });
    expect(last.input.ExpressionAttributeValues[':list']).toContainEqual(child);
  });

  it('gives up after a bounded number of tries, unlisted and without throwing', async () => {
    mockDdbSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'Get') return { Item: { children: full } };
      throw failed();
    });
    await expect(recordChildConversation(PARENT, child)).resolves.toBe(false);
    expect(mockDdbSend.mock.calls.filter((c) => c[0].__type === 'Update')).toHaveLength(4);
  });

  it('a failure other than the condition is not retried', async () => {
    mockDdbSend.mockRejectedValue(Object.assign(new Error('t'), { name: 'ProvisionedThroughputExceededException' }));
    await expect(recordChildConversation(PARENT, child)).resolves.toBe(false);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });
});

describe('the active meeting is claimed and released conditionally', () => {
  const MEETING = {
    meetingId: 'm-1',
    meeting: { MeetingId: 'm-1' },
    classification: 'premium',
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: 'alice',
  };

  it('claims only when the conversation has no meeting recorded', async () => {
    mockDdbSend.mockResolvedValue({});
    expect(await claimActiveMeeting(ARN, MEETING)).toBe('claimed');
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(#meeting)');
    expect(cmd.input.ExpressionAttributeNames['#meeting']).toBe('activeMeeting');
    expect(cmd.input.ExpressionAttributeValues[':meeting']).toEqual(MEETING);
  });

  it('tells a losing starter it lost, so it can delete the meeting it made', async () => {
    mockDdbSend.mockRejectedValue(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
    expect(await claimActiveMeeting(ARN, MEETING)).toBe('lost');
  });

  it('reports a store failure as failed, never as claimed', async () => {
    mockDdbSend.mockRejectedValue(Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' }));
    expect(await claimActiveMeeting(ARN, MEETING)).toBe('failed');
  });

  it('releases only the meeting the caller observed', async () => {
    mockDdbSend.mockResolvedValue({});
    expect(await releaseActiveMeeting(ARN, 'm-1')).toBe('released');
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.input.ConditionExpression).toBe('#meeting.#meetingId = :meetingId');
    expect(cmd.input.ExpressionAttributeValues[':meetingId']).toBe('m-1');
    // The field is removed, not set to null: `attribute_not_exists` is the claim condition, and a null
    // left behind would read as "a meeting is recorded" and block every later start.
    expect(cmd.input.UpdateExpression).toContain('REMOVE #meeting');
  });

  it('records when the meeting ended in the same write that clears it, so no reader finds it neither running nor ended', async () => {
    mockDdbSend.mockResolvedValue({});
    expect(await releaseActiveMeeting(ARN, 'm-1', '2026-11-17T10:00:00.000Z')).toBe('released');
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const cmd = mockDdbSend.mock.calls[0][0];
    expect(cmd.input.UpdateExpression).toBe('REMOVE #meeting SET #updatedAt = :updatedAt, #last.#endedAt = :endedAt');
    expect(cmd.input.ConditionExpression).toBe('#meeting.#meetingId = :meetingId AND #last.#meetingId = :meetingId');
    expect(cmd.input.ExpressionAttributeValues[':endedAt']).toBe('2026-11-17T10:00:00.000Z');
  });

  it('releases without the stamp a record whose last meeting is not this one, and reports a superseded one as superseded', async () => {
    const lost = Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
    mockDdbSend.mockRejectedValueOnce(lost).mockResolvedValueOnce({});
    expect(await releaseActiveMeeting(ARN, 'm-1', '2026-11-17T10:00:00.000Z')).toBe('released');
    expect(mockDdbSend.mock.calls[1][0].input.UpdateExpression).toBe('REMOVE #meeting SET #updatedAt = :updatedAt');
    mockDdbSend.mockReset();
    mockDdbSend.mockRejectedValue(lost);
    expect(await releaseActiveMeeting(ARN, 'm-1', '2026-11-17T10:00:00.000Z')).toBe('superseded');
  });

  it('does not clear a different meeting that was claimed in the meantime', async () => {
    mockDdbSend.mockRejectedValue(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
    expect(await releaseActiveMeeting(ARN, 'm-1')).toBe('superseded');
  });

  it('refuses both writes when the table is unconfigured rather than reporting success', async () => {
    delete process.env.CHANNEL_CONTEXT_TABLE;
    expect(await claimActiveMeeting(ARN, MEETING)).toBe('failed');
    expect(await releaseActiveMeeting(ARN, 'm-1')).toBe('failed');
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  // THE GUARD, PINNED. `activeMeeting` is deliberately absent from OWNED_FIELDS so that the
  // last-write-wins writer cannot express an unconditional claim, which would orphan a running meeting.
  // If somebody adds it to that list to "fix" a discarded write, this fails and says why.
  it('cannot be written through the unconditional writer at all', async () => {
    mockDdbSend.mockResolvedValue({});
    const wrote = await putChannelContext(ARN, { activeMeeting: MEETING } as never);
    // Nothing but the timestamp was in the patch, so the writer no-ops without touching the store.
    expect(mockDdbSend).not.toHaveBeenCalled();
    expect(wrote).toBe(true);
  });
});
