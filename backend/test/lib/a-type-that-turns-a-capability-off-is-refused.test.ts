/**
 * A CONVERSATION TYPE'S `capabilities: false` IS REFUSED BY THE ROUTE THAT WOULD DO IT (`lib/type-capability.ts`).
 *
 * The type is read from the channel context row the creator wrote, never from member-writable Metadata, and a row
 * that cannot be read refuses rather than reading the capability as on.
 */
import { typeAllows } from '../../lambda/src/lib/type-capability';

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/app/channel/room-1';
const rowOf = (conversationType?: string) => ({
  send: jest.fn(async () => (conversationType === undefined ? {} : { Item: { conversationType: { S: conversationType } } })),
});

describe('a type that turns a capability off is refused', () => {
  it.each(['attachments', 'sharing', 'tasks'] as const)('refuses %s in a customer engagement', async (capability) => {
    const answer = await typeAllows(CHANNEL, capability, { table: 'ctx', doc: rowOf('customer-engagement') });
    expect(answer).toMatchObject({ ok: false, statusCode: 403, code: 'CAPABILITY_OFF_FOR_TYPE', capability });
  });

  it('allows each capability in an ordinary conversation, and in one with no context row', async () => {
    for (const capability of ['attachments', 'sharing', 'tasks'] as const) {
      expect(await typeAllows(CHANNEL, capability, { table: 'ctx', doc: rowOf('general') })).toEqual({ ok: true });
      expect(await typeAllows(CHANNEL, capability, { table: 'ctx', doc: rowOf(undefined) })).toEqual({ ok: true });
    }
  });

  it('reads the row the creator wrote, by the conversation, projecting only its type', async () => {
    const doc = rowOf('general');
    await typeAllows(CHANNEL, 'attachments', { table: 'ctx', doc });
    const input = (doc.send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input;
    expect(input).toMatchObject({ TableName: 'ctx', Key: { channelArn: { S: CHANNEL } }, ProjectionExpression: 'conversationType, meetingOf' });
  });

  it('refuses when the type cannot be read, rather than reading the capability as on', async () => {
    const doc = { send: jest.fn(async () => { throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }); }) };
    expect(await typeAllows(CHANNEL, 'attachments', { table: 'ctx', doc })).toMatchObject({ ok: false, statusCode: 503, code: 'CONVERSATION_TYPE_UNREADABLE' });
  });

  // A MEETING IS ENTERED BY ITS ADMISSION RULE (FR42, FR43, FR53), never by a member's share.
  it("DENY: refuses sharing into a meeting's conversation, wherever it was started", async () => {
    expect(await typeAllows(CHANNEL, 'sharing', { table: 'ctx', doc: rowOf('meeting') })).toMatchObject({ ok: false, statusCode: 403, code: 'CAPABILITY_OFF_FOR_TYPE', conversationType: 'meeting' });
  });

  it("DENY: a meeting's conversation allows no more than its room: a customer's room's meeting carries no attachments or tasks", async () => {
    const ROOM = CHANNEL.replace('room-1', 'customer-room');
    const doc = { send: jest.fn(async (c: { input: { Key: { channelArn: { S: string } } } }) => (c.input.Key.channelArn.S === ROOM
      ? { Item: { conversationType: { S: 'customer-engagement' } } }
      : { Item: { conversationType: { S: 'meeting' }, meetingOf: { S: ROOM } } })) };
    for (const capability of ['attachments', 'tasks'] as const) {
      expect(await typeAllows(CHANNEL, capability, { table: 'ctx', doc: doc as never })).toMatchObject({ ok: false, statusCode: 403, conversationType: 'customer-engagement' });
    }
    // An ordinary room's meeting keeps them.
    const ordinary = { send: jest.fn(async (c: { input: { Key: { channelArn: { S: string } } } }) => (c.input.Key.channelArn.S === ROOM
      ? { Item: { conversationType: { S: 'general' } } }
      : { Item: { conversationType: { S: 'meeting' }, meetingOf: { S: ROOM } } })) };
    expect(await typeAllows(CHANNEL, 'attachments', { table: 'ctx', doc: ordinary as never })).toEqual({ ok: true });
  });

  it('refuses when no context table is configured', async () => {
    expect(await typeAllows(CHANNEL, 'tasks', { table: '', doc: rowOf('general') })).toMatchObject({ ok: false, statusCode: 503 });
  });
});
