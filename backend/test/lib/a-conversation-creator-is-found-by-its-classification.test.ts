/**
 * A CONVERSATION CREATOR IS FOUND BY ITS CLASSIFICATION AT CALL TIME (the classification-independence plan,
 * step 4).
 *
 * Each classification's creator is built by its own stack, which publishes the function's ARN under
 * `${CONVERSATION_CREATOR_PARAM_ROOT}/<classification>/conversation-creator-arn`; a caller reads that key when it
 * opens a conversation there. Only a declared conversational value forms a name (the admin plane has no
 * creator), a missing or unreadable parameter finds nothing and is not remembered, and a found ARN is kept.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ input })),
}));

import { resolveConversationCreatorArn, resetConversationCreatorArnCache } from '../../lambda/src/lib/conversation-creator-arn';

const ROOT = '/agent-echelon/assistant';
const BASIC = 'arn:aws:lambda:us-east-1:111122223333:function:agent-echelon-basic-conversation-creator';

beforeEach(() => {
  resetConversationCreatorArnCache();
  mockSend.mockReset();
  delete process.env.CONVERSATION_CREATORS;
  process.env.CONVERSATION_CREATOR_PARAM_ROOT = ROOT;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

it('reads the classification\'s own key, once per container', async () => {
  mockSend.mockResolvedValue({ Parameter: { Value: BASIC } });
  expect(await resolveConversationCreatorArn('basic')).toBe(BASIC);
  expect(await resolveConversationCreatorArn('basic')).toBe(BASIC);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0].input).toEqual({ Name: `${ROOT}/basic/conversation-creator-arn` });
});

it('forms no name for the admin plane or an undeclared value', async () => {
  expect(await resolveConversationCreatorArn('admin')).toBeUndefined();
  expect(await resolveConversationCreatorArn('../x')).toBeUndefined();
  expect(mockSend).not.toHaveBeenCalled();
});

it('finds nothing when the parameter is missing or unreadable, and does not remember the miss', async () => {
  mockSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ParameterNotFound' }));
  expect(await resolveConversationCreatorArn('standard')).toBeUndefined();
  mockSend.mockResolvedValueOnce({ Parameter: { Value: BASIC } });
  expect(await resolveConversationCreatorArn('standard')).toBe(BASIC);
});

it('takes an explicit map in the environment first', async () => {
  process.env.CONVERSATION_CREATORS = JSON.stringify({ basic: 'arn:explicit' });
  expect(await resolveConversationCreatorArn('basic')).toBe('arn:explicit');
  expect(mockSend).not.toHaveBeenCalled();
});
