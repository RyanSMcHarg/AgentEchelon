/**
 * A CLASSIFICATION'S BADGE COLOR AND AUDIENCE COME FROM ITS DEFINITION, AND REACH THE CLIENTS.
 *
 *  - `badgeToken` is one of the categorical palette's eight (`cls-1` to `cls-8`); one outside it, or two
 *    classifications declaring the same one, is refused at synth (`validateProfilesConfig`).
 *  - An absent token takes the lowest-numbered one nobody declares, in declaration order, and the palette
 *    repeats once all eight are taken (`clientClassifications`).
 *  - The set the deployment runs reaches the clients from `GET /classifications` (`classifications-api.ts`), which
 *    answers from the runtime registry: each classification's name, audience, badge token and grants, so a custom
 *    set renders its own names and colors, and a classification added later renders with no frontend build.
 */
import * as cdk from 'aws-cdk-lib';
import { seedRegistryRows, clearRegistryRows } from './helpers/registry-rows';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import {
  BADGE_TOKENS,
  DEFAULT_PROFILES_CONFIG,
  clientClassifications,
  resolveDeploymentProfiles,
  validateProfilesConfig,
  type ProfilesConfig,
} from '../lib/config/profiles';
import { useDeploymentProfiles } from '../lib/profile-registry';
import { PersonApiStack } from '../lib/stacks/person-api-stack';
import { CUSTOM_PROFILES } from './deploy-matrix/configurations';

const withTokens = (tokens: Array<string | undefined>): ProfilesConfig => ({
  ...CUSTOM_PROFILES,
  classifications: CUSTOM_PROFILES.classifications.map((c, i) => ({ ...c, ...(tokens[i] ? { badgeToken: tokens[i] as never } : {}) })),
});

afterEach(() => useDeploymentProfiles(DEFAULT_PROFILES_CONFIG));

describe('a badge token', () => {
  it('is one of the eight categorical tokens', () => {
    expect(BADGE_TOKENS).toEqual(['cls-1', 'cls-2', 'cls-3', 'cls-4', 'cls-5', 'cls-6', 'cls-7', 'cls-8']);
    expect(() => validateProfilesConfig(withTokens(['cls-9']))).toThrow(/badgeToken 'cls-9' is not one of cls-1/);
    expect(() => validateProfilesConfig(withTokens(['tier-premium']))).toThrow(/is not one of/);
    expect(() => validateProfilesConfig(withTokens(['cls-2', 'cls-7']))).not.toThrow();
  });

  it('names one classification', () => {
    expect(() => validateProfilesConfig(withTokens(['cls-3', 'cls-3']))).toThrow(/'finance' and 'legal' both declare badgeToken 'cls-3'/);
  });

  it('is declared on every shipped classification but the admin plane, which takes the first free one', () => {
    const shipped = clientClassifications(DEFAULT_PROFILES_CONFIG);
    expect(shipped.map((c) => [c.value, c.badgeToken])).toEqual([
      ['basic', 'cls-1'], ['standard', 'cls-2'], ['premium', 'cls-3'], ['admin', 'cls-4'], ['guest', 'cls-5'], ['customer', 'cls-6'],
    ]);
  });

  it('is assigned in declaration order around the declared ones, and the palette repeats past eight', () => {
    const config = resolveDeploymentProfiles(withTokens([undefined, 'cls-1']));
    expect(clientClassifications(config).map((c) => [c.value, c.badgeToken])).toEqual([['legal', 'cls-2'], ['finance', 'cls-1'], ['admin', 'cls-3']]);

    const many: ProfilesConfig = {
      ...CUSTOM_PROFILES,
      classifications: Array.from({ length: 10 }, (_, i) => ({ ...CUSTOM_PROFILES.classifications[0], value: `c${i}`, grants: [`c${i}`] })),
      groupClearance: {},
    };
    expect(clientClassifications(many).map((c) => c.badgeToken)).toEqual([...BADGE_TOKENS, 'cls-1', 'cls-2']);
  });
});

describe('what a client is told', () => {
  it('is each classification\'s name, audience, badge token and grants, and whether a conversation is held at it', () => {
    const shipped = clientClassifications(DEFAULT_PROFILES_CONFIG);
    expect(shipped.find((c) => c.value === 'standard')).toEqual({
      value: 'standard', displayName: 'Standard', audience: 'members', badgeToken: 'cls-2', grants: ['basic', 'standard'], conversational: true,
      models: { selected: ['haiku', 'sonnet', 'titan', 'gpt_oss_20b', 'deepseek_v3', 'deepseek_r1'], default: 'sonnet' },
    });
    expect(shipped.find((c) => c.value === 'customer')).toMatchObject({ audience: 'outside', displayName: 'Customer', conversational: true });
    expect(shipped.find((c) => c.value === 'admin')).toEqual({
      value: 'admin', displayName: 'Admin', audience: 'members', badgeToken: 'cls-4', grants: ['admin'], conversational: false, adminPlane: true,
      models: { selected: ['haiku'], default: 'haiku' },
    });
  });

  it('reaches the clients from GET /classifications, read from the runtime registry, and from no stack output', async () => {
    const answer = async () => {
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { handler } = require('../lambda/src/classifications-api');
      const res = await handler({ headers: { origin: 'http://localhost:5173' } });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body).classifications as Array<{ value: string; displayName: string; badgeToken: string }>;
    };
    seedRegistryRows(resolveDeploymentProfiles(CUSTOM_PROFILES));
    try {
      // The rows assemble in the order of their values, and a badge nobody declares is taken in that order.
      expect((await answer()).map((c) => [c.value, c.displayName, c.badgeToken]))
        .toEqual([['admin', 'Admin', 'cls-1'], ['finance', 'Finance', 'cls-2'], ['legal', 'Legal', 'cls-3']]);
      seedRegistryRows(resolveDeploymentProfiles(undefined));
      expect((await answer()).map((c) => c.value)).toEqual(['admin', 'basic', 'premium', 'standard']);
    } finally {
      clearRegistryRows();
      jest.resetModules();
    }
    const app = new cdk.App();
    const env = { account: '111122223333', region: 'us-east-1' };
    const host = new cdk.Stack(app, 'Host', { env });
    const stack = new PersonApiStack(app, 'P', {
      env, routes: [], appInstanceArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i', selfPoolId: 'us-east-1_POOL', selfClientIds: ['client-1'],
      identities: dynamodb.Table.fromTableArn(host, 'I', 'arn:aws:dynamodb:us-east-1:111122223333:table/identities'),
    });
    expect(Object.keys(Template.fromStack(stack).findOutputs('Classifications'))).toEqual([]);
  });
});
