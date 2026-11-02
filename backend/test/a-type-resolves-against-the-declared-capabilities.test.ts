/**
 * T4, FR7, FR9, FR14: A CONVERSATION TYPE'S TRANSPORTS AND CAPABILITIES RESOLVE AGAINST THE DECLARED CAPABILITY LIST.
 *
 *  - a transport or capability the deployment serves resolves on; one it does not resolves off and is a
 *    recorded gap, naming what it needs, and nothing is ever refused;
 *  - chat is the hub and never resolves away; a capability declared off is no gap;
 *  - every shipped type resolves with no gap in every configuration the shipped capabilities allow;
 *  - the gaps are recorded on `PersonApi` as `ConversationTypeGaps`.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import { CONVERSATION_TYPES } from '../lib/config/conversation-types';
import { describeGap, resolveTypeForDeployment, typeCapabilityGaps } from '../lib/config/type-capabilities';
import { CAPABILITIES } from '../lib/config/capabilities';
import { PersonApiStack } from '../lib/stacks/person-api-stack';

const TYPES = CONVERSATION_TYPES as Record<string, unknown>;
function withType<T>(key: string, config: Record<string, unknown>, run: () => T): T {
  const prior = TYPES[key];
  TYPES[key] = config;
  try { return run(); } finally { if (prior) TYPES[key] = prior; else delete TYPES[key]; }
}

const SUPPORT = {
  driftEnabled: false,
  commsChannels: ['chat', 'email', 'voice', 'carrier-pigeon'],
  capabilities: { battle: true, sharing: true, tasks: true, attachments: false, teleport: true },
};

describe('one type against a declared list', () => {
  it('serves what the deployment declares, and turns the rest off with the reason recorded', () => {
    withType('support', SUPPORT, () => {
      const bare = resolveTypeForDeployment('support', []);
      expect(bare.commsChannels).toEqual(['chat']);
      expect(bare.capabilities).toEqual({ battle: false, sharing: false, tasks: true, attachments: false, teleport: false });
      expect(bare.gaps.map(describeGap)).toEqual([
        'support: transport email is off (needs the notifications capability)',
        'support: transport voice is off (no provider is built)',
        'support: transport carrier-pigeon is off (no capability serves it)',
        'support: capability battle is off (needs the battle capability)',
        'support: capability sharing is off (needs the notifications capability)',
        'support: capability teleport is off (no capability serves it)',
      ]);

      const full = resolveTypeForDeployment('support', ['notifications', 'experiments', 'battle']);
      expect(full.commsChannels).toEqual(['chat', 'email']);
      expect(full.capabilities).toMatchObject({ battle: true, sharing: true, tasks: true });
      expect(full.gaps.map((g) => g.value)).toEqual(['voice', 'carrier-pigeon', 'teleport']);
    });
  });

  it('keeps chat when a type names none, and a capability declared off is no gap', () => {
    withType('quiet', { driftEnabled: false, commsChannels: ['email'], capabilities: { battle: false } }, () => {
      const r = resolveTypeForDeployment('quiet', []);
      expect(r.commsChannels).toEqual(['chat']);
      expect(r.gaps.map((g) => g.value)).toEqual(['email']);
    });
  });
});

describe('the shipped types', () => {
  it('resolve with no gap whatever the shipped capabilities declare', () => {
    expect(typeCapabilityGaps([])).toEqual([]);
    expect(typeCapabilityGaps(CAPABILITIES.map((c) => c.name))).toEqual([]);
  });
});

describe('the record on PersonApi', () => {
  it('is the ConversationTypeGaps output, one line per gap, or none', () => {
    const outputs = (gaps?: string[]) => {
      const app = new cdk.App();
      const env = { account: '111122223333', region: 'us-east-1' };
      const host = new cdk.Stack(app, 'Host', { env });
      const stack = new PersonApiStack(app, 'P', {
        env, routes: [], appInstanceArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i', selfPoolId: 'us-east-1_POOL', selfClientIds: ['client-1'],
        identities: dynamodb.Table.fromTableArn(host, 'I', 'arn:aws:dynamodb:us-east-1:111122223333:table/identities'),
        ...(gaps ? { conversationTypeGaps: gaps } : {}),
      });
      return Template.fromStack(stack).findOutputs('ConversationTypeGaps');
    };
    expect(Object.values(outputs())[0].Value).toBe('none');
    expect(Object.values(outputs(['a: transport email is off', 'b: capability battle is off']))[0].Value)
      .toBe('a: transport email is off; b: capability battle is off');
  });
});
