/**
 * A BATTLE PICK NAMES THE TWO VERSIONS IT JUDGED (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5, §3.6).
 *
 * `BattleOutcome.controlConfigId` and `treatmentConfigId` were declared and written by nothing. Arming now
 * pins both versions with their configIds on the experiment row, and a pick reads them from there, so a
 * pick stays attributable to exactly what fought - including after the treatment is promoted, since the
 * promoted version keeps the candidate's configId.
 */
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return { ...actual, DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) } };
});

import { pinnedConfigIds } from '../lambda/src/battle-outcome-api';

beforeEach(() => {
  mockDdbSend.mockReset();
  process.env.EXPERIMENTS_TABLE = 'experiments';
});

describe('pinnedConfigIds', () => {
  it('reads the control and treatment configIds the experiment pinned', async () => {
    mockDdbSend.mockResolvedValue({ Item: { experimentId: 'exp-1', variants: [
      { variantId: 'control', controlPin: { profileName: 'advisor', version: 3, configId: 'cfg-live' } },
      { variantId: 'treatment', altPin: { profileName: 'alt-primary-premium', version: 4, configId: 'cfg-cand' } },
    ] } });
    expect(await pinnedConfigIds('exp-1')).toEqual({ controlConfigId: 'cfg-live', treatmentConfigId: 'cfg-cand' });
    expect(mockDdbSend.mock.calls[0][0].input).toEqual({ TableName: 'experiments', Key: { experimentId: 'exp-1' } });
  });

  it('records nothing it cannot read: pins without configIds, a missing row, a failed read', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { variants: [{ controlPin: { profileName: 'advisor', version: 3 } }, {}] } });
    expect(await pinnedConfigIds('exp-1')).toEqual({});
    mockDdbSend.mockResolvedValueOnce({});
    expect(await pinnedConfigIds('exp-1')).toEqual({});
    mockDdbSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    expect(await pinnedConfigIds('exp-1')).toEqual({});
  });
});
