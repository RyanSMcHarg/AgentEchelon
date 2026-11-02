/**
 * A conversation whose people come from a group refuses sharing (owner decision, 2026-10-05): the
 * membership reconcile would silently remove whoever was invited. The refusal reads the server-side
 * context row, never channel Metadata, and gives the same sentence the client's disabled Share tooltip
 * shows.
 */
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

process.env.CHANNEL_CONTEXT_TABLE = 'ctx-table';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __forTests } = require('../../lambda/share-conversation/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const en = require('../../../frontend/packages/shared/src/locales/en.json');

beforeEach(() => mockDdbSend.mockReset());

describe('sharing a conversation whose membership comes from a source', () => {
  it('reads the source from the context row', async () => {
    mockDdbSend.mockResolvedValue({ Item: { membershipSource: { S: 'group:ops' } } });
    expect(await __forTests.enforcedMembershipSource('arn:ch')).toBe('group:ops');
    expect(mockDdbSend.mock.calls[0][0].input).toMatchObject({ TableName: 'ctx-table', ProjectionExpression: 'membershipSource' });
  });

  it('allows the share when the row has no source, and when the row cannot be read', async () => {
    mockDdbSend.mockResolvedValue({ Item: {} });
    expect(await __forTests.enforcedMembershipSource('arn:ch')).toBe('');
    mockDdbSend.mockRejectedValue(Object.assign(new Error('x'), { name: 'ThrottlingException' }));
    expect(await __forTests.enforcedMembershipSource('arn:ch')).toBe('');
  });

  it('refuses in the same words the client tooltip uses', () => {
    const server = __forTests.membershipSourceRefusal('group:ops');
    const client = en.conversation.shareDisabledGroup.replace('{{group}}', 'ops');
    expect(server).toBe(client);
    expect(__forTests.membershipSourceRefusal('list')).toBe(en.conversation.shareDisabledList);
  });
});
