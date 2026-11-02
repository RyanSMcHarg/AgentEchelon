/**
 * RETRIEVAL REACHES EXACTLY WHAT THE S3 CONTEXT PREFIXES AND THE READER ROLE REACH.
 *
 * Company documents are reached through `contextPrefixesGranted` (the grant set) and the vector
 * store's reader role is scoped by `scopeFunctionSql` (the grant set), while the retrieval filter and
 * its cross-check were built from `scopeAtOrBelow` (the rank ladder). For the shipped ladder the two
 * lists are equal, so only a NON-CONTIGUOUS grant set tells them apart: `finance` grants basic+finance
 * and ranks above standard and premium.
 */

const mockBedrockSend = jest.fn();
const mockDbQuery = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args) => ({ __type: 'InvokeModel', input: args })),
}));
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: mockDbQuery, getClient: jest.fn() }));
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withReaderRole: jest.fn(async (_c: string, fn: (c: unknown) => unknown) =>
    fn({ query: require('../../lambda/src/analytics-aurora/db-client').query })),
  withWriterRole: jest.fn(),
}));

// The deployment's registry, replaced by one that declares a non-contiguous grant set. Built on first
// read, not in the factory: the real registry imports `model-strategy`, which imports the registry back,
// so the factory re-enters while the real module is half-loaded. One instance is shared by both entries.
jest.mock('../../lib/profile-registry', () => {
  const actual = jest.requireActual('../../lib/profile-registry');
  const build = () => {
    const { DEFAULT_PROFILES_CONFIG } = jest.requireActual('../../lib/config/profiles');
    return new actual.ProfileRegistry({
      ...DEFAULT_PROFILES_CONFIG,
      classifications: [
        ...DEFAULT_PROFILES_CONFIG.classifications,
        { value: 'finance', rank: 5, profile: 'advisor', grants: ['basic', 'finance'] },
      ],
      groupClearance: { ...DEFAULT_PROFILES_CONFIG.groupClearance, finance: 'finance' },
    });
  };
  const shared = globalThis as { mockFinanceRegistry?: unknown };
  return new Proxy({}, {
    get: (_target, key) =>
      key === 'defaultProfileRegistry' ? (shared.mockFinanceRegistry ??= build()) : actual[key],
  });
});

import { defaultProfileRegistry } from '../../lib/profile-registry';
import { retrieveContext } from '../../lambda/src/analytics-aurora/document-retrieval';
import { scopeFunctionSql } from '../../lambda/src/analytics-aurora/classification-boundary-sql';

const reg = defaultProfileRegistry;

function embedOk() {
  mockBedrockSend.mockResolvedValueOnce({
    body: new TextEncoder().encode(JSON.stringify({ embedding: new Array(1024).fill(0.1) })),
  });
}

beforeEach(() => jest.clearAllMocks());

describe('a non-contiguous grant set reaches the same classifications on every path', () => {
  it('is genuinely non-contiguous, so the cases below are not satisfied by a prefix', () => {
    // THE FIXTURE HAS TO SKIP SOMETHING, or every assertion below would pass for a plain ladder and
    // prove nothing about grant sets. This used to make the point by contrasting `grantsFor` with
    // `scopeAtOrBelow`; that resolver is deleted (ADR-046), so the property is stated directly.
    expect(reg.grantsFor('finance')).toEqual(['basic', 'finance']);
    expect(reg.classificationValues()).toContain('standard');
    expect(reg.grantsFor('finance')).not.toContain('standard');
  });

  it('filters retrieval on the grant set, the same set the S3 prefixes and the reader role use', async () => {
    embedOk();
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await retrieveContext({ query: 'q3 budget', classificationScope: reg.grantsFor('finance'), classification: 'finance' });

    const filtered = mockDbQuery.mock.calls[0][1][2] as string[];
    const s3 = reg.contextPrefixesGranted('finance').map((p) => p.replace(/^context\/|\/$/g, ''));
    const role = /WHEN 'ae_reader_finance' THEN ARRAY\[([^\]]*)\]/.exec(scopeFunctionSql(reg))![1]
      .split(',').map((v) => v.trim().replace(/'/g, ''));
    expect([...filtered].sort()).toEqual([...s3].sort());
    expect([...filtered].sort()).toEqual([...role].sort());
  });

  it('refuses a scope wider than the grant set, because the role would withhold what the filter names', async () => {
    // THE LADDER, WRITTEN OUT. This passed `scopeAtOrBelow('finance')` - the rank-derived scope,
    // which includes `standard` because it sits between `basic` and `finance` in the order. That
    // resolver is deleted (ADR-046), so the wrong scope is named directly: the property under test is
    // that a filter naming more than the reader role grants is refused BEFORE the query runs, not
    // that one particular resolver produced it.
    await expect(retrieveContext({
      query: 'q3 budget', classificationScope: ['basic', 'standard', 'finance'], classification: 'finance',
    })).rejects.toThrow(/would enforce different boundaries/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('the turn builds its retrieval scope from the grant set', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../lambda/src/lib/turn-grounding.ts'), 'utf8',
    );
    expect(src).toMatch(/const classificationScope = profiles\.grantsFor\(classification\)/);
    expect(src).not.toMatch(/scopeAtOrBelow\(/);
  });
});
