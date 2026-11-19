/**
 * A STOP'S QUESTION IS SENT WHEN ITS ACKNOWLEDGEMENT IS RELEASED (`deferStopEvaluation`, `takeStopEvaluation`).
 *
 * The router records the question's dispatch against the acknowledgement's message id; the channel flow takes it from
 * the pass that releases that message. Taken once, because the flow sees the same message again on every update, and
 * never for a different acknowledgement.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  UpdateCommand: jest.fn().mockImplementation((input) => ({ __type: 'Update', input })),
  GetCommand: jest.fn().mockImplementation((input) => ({ __type: 'Get', input })),
  DeleteCommand: jest.fn().mockImplementation((input) => ({ __type: 'Delete', input })),
}));

process.env.TURN_STATE_TABLE = 'turn-state';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deferStopEvaluation, takeStopEvaluation } = require('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/app/channel/room-1';
const DISPATCH = {
  channelArn: CHANNEL,
  botArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/app/bot/advisor',
  classification: 'premium',
  correlationId: 'stop-advisor-1',
  senderArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/app/user/p1',
  cancelledLabels: ['a report'],
};

beforeEach(() => mockSend.mockReset());

describe("a stop's question follows its acknowledgement", () => {
  it('records the dispatch against the acknowledgement, on the responder\'s turn record', async () => {
    mockSend.mockResolvedValue({});
    expect(await deferStopEvaluation({ channelArn: CHANNEL, responderId: 'advisor', acknowledgementId: 'ack-1', dispatch: DISPATCH })).toBe(true);
    const input = mockSend.mock.calls[0][0].input;
    expect(input).toMatchObject({ TableName: 'turn-state', Key: { pk: `turn#${CHANNEL}#advisor` }, UpdateExpression: 'SET stopEvaluation = :e' });
    expect(input.ExpressionAttributeValues[':e']).toMatchObject({ acknowledgementId: 'ack-1', dispatch: DISPATCH });
  });

  it('answers false when the record cannot be written, so the router dispatches the question itself', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));
    expect(await deferStopEvaluation({ channelArn: CHANNEL, responderId: 'advisor', acknowledgementId: 'ack-1', dispatch: DISPATCH })).toBe(false);
  });

  it('takes the dispatch for its own acknowledgement, removing it as it reads', async () => {
    mockSend.mockResolvedValue({ Attributes: { stopEvaluation: { acknowledgementId: 'ack-1', dispatch: DISPATCH } } });
    expect(await takeStopEvaluation({ channelArn: CHANNEL, responderId: 'advisor', acknowledgementId: 'ack-1' })).toEqual(DISPATCH);
    const input = mockSend.mock.calls[0][0].input;
    expect(input).toMatchObject({
      UpdateExpression: 'REMOVE stopEvaluation',
      ConditionExpression: 'stopEvaluation.acknowledgementId = :a',
      ExpressionAttributeValues: { ':a': 'ack-1' },
      ReturnValues: 'ALL_OLD',
    });
  });

  it('takes nothing on a second sighting, or for another acknowledgement', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' }));
    expect(await takeStopEvaluation({ channelArn: CHANNEL, responderId: 'advisor', acknowledgementId: 'ack-1' })).toBeUndefined();
  });

  it('surfaces a failed read rather than reading it as nothing to send', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('down'), { name: 'InternalServerError' }));
    await expect(takeStopEvaluation({ channelArn: CHANNEL, responderId: 'advisor', acknowledgementId: 'ack-1' })).rejects.toThrow('down');
  });
});
