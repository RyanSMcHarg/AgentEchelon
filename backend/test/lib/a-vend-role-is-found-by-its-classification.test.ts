/**
 * A VEND ROLE IS FOUND BY ITS CLASSIFICATION AT CALL TIME (the classification-independence plan, step 4).
 *
 * Each classification's vend role is built by its own stack, which publishes the ARN under
 * `${EXCHANGE_ROLE_ARN_PARAM_ROOT}/<classification>/exchange-role-arn`; the exchange reads that one key when it vends at the
 * classification, so its environment names none. An undeclared value forms no parameter name, a missing or
 * unreadable parameter vends nothing, and a found ARN is kept for the container.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ input })),
}));

import { resolveExchangeRoleArn, resetExchangeRoleArnCache } from '../../lambda/src/lib/exchange-role-arn';

const ROOT = '/agent-echelon/assistant';
const BASIC = 'arn:aws:iam::111122223333:role/agent-echelon/exchange/agent-echelon-exchange-basic';

beforeEach(() => {
  resetExchangeRoleArnCache();
  mockSend.mockReset();
  delete process.env.EXCHANGE_ROLE_ARNS_JSON;
  process.env.EXCHANGE_ROLE_ARN_PARAM_ROOT = ROOT;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

it('reads the classification\'s own key, once per container', async () => {
  mockSend.mockResolvedValue({ Parameter: { Value: BASIC } });
  expect(await resolveExchangeRoleArn('basic')).toBe(BASIC);
  expect(await resolveExchangeRoleArn('basic')).toBe(BASIC);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0].input).toEqual({ Name: `${ROOT}/basic/exchange-role-arn` });
});

it('forms no parameter name for an undeclared value', async () => {
  expect(await resolveExchangeRoleArn('../admin')).toBeUndefined();
  expect(await resolveExchangeRoleArn('not-declared')).toBeUndefined();
  expect(mockSend).not.toHaveBeenCalled();
});

it('vends nothing when the parameter is missing, empty or unreadable, and does not remember the miss', async () => {
  mockSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ParameterNotFound' }));
  expect(await resolveExchangeRoleArn('standard')).toBeUndefined();
  mockSend.mockResolvedValueOnce({ Parameter: { Value: '' } });
  expect(await resolveExchangeRoleArn('standard')).toBeUndefined();
  mockSend.mockResolvedValueOnce({ Parameter: { Value: BASIC.replace('basic', 'standard') } });
  expect(await resolveExchangeRoleArn('standard')).toBe(BASIC.replace('basic', 'standard'));
});

it('vends nothing without the parameter root', async () => {
  delete process.env.EXCHANGE_ROLE_ARN_PARAM_ROOT;
  expect(await resolveExchangeRoleArn('basic')).toBeUndefined();
  expect(mockSend).not.toHaveBeenCalled();
});

it('takes an explicit map in the environment first, as the router lookup does', async () => {
  process.env.EXCHANGE_ROLE_ARNS_JSON = JSON.stringify({ basic: 'arn:aws:iam::1:role/explicit' });
  expect(await resolveExchangeRoleArn('basic')).toBe('arn:aws:iam::1:role/explicit');
  expect(mockSend).not.toHaveBeenCalled();
});
