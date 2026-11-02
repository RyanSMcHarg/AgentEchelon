/**
 * NO STACK OWNS AN ASSISTANT IDENTITY; A DEPLOY DECLARES ITS ASSISTANTS TO THE SEED (ADR-048, amended 2026-10-24).
 *
 * Synthesis of the premium classification (its primary, its `ops` role and a duel's alt) and of the admin backend
 * (the admin assistant). What is pinned:
 *   - no CloudFormation resource creates, names or records an assistant identity: no Amazon Lex or
 *     `AppInstanceBot` custom resource, no assignment record, no name applier, no Amazon Lex runtime role, in
 *     either stack;
 *   - each declares its assistants to one seed, whose property is the declaration, and reads the primary's ARN
 *     from the seed's answer;
 *   - the seed's function is a thin adapter: its role holds one grant, invoking the provisioner by its fixed name,
 *     and its environment names the classification it serves, which the provisioner holds the declaration to;
 *   - the premium seed asks only after premium's registry row is published, so the row it is held to is current;
 *   - nothing an update can delete is an identity, because no identity is a resource: the provisioner decides
 *     removal (unit-tested in `a-deploy-seeds-its-declared-assistants-once.test.ts`). That exactly one role in the
 *     whole app holds an identity or Amazon Lex write is `one-principal-builds-every-assistant.test.ts`.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS, adminServicesTemplate } from './helpers/synth';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { ASSISTANT_PROVISIONER_FUNCTION_NAME } from '../lib/stacks/agent-classification-common';

type Resource = { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string };
type Statement = { Effect?: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };

const premium = Template.fromStack(assistantsOf('premium')(new cdk.App(), 'AgentEchelonAssistants-premium', {
  ...CLASSIFICATION_TEST_PROPS, battle: true,
} as never)).toJSON() as { Resources: Record<string, Resource> };
const admin = adminServicesTemplate().toJSON() as { Resources: Record<string, Resource> };

const resourcesOf = (t: { Resources: Record<string, Resource> }) => Object.entries(t.Resources);
const text = (v: unknown) => JSON.stringify(v);
const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

/** A declaration on the stack's seed: its main one (`<seed>Resource...`), or a capability's (`DeclaredDuelAlts`). */
function seedOf(t: { Resources: Record<string, Resource> }, idPrefix: RegExp = /^(DeclaredAssistants|AdminAgentSeed)[0-9A-F]{8}$/) {
  const seeds = resourcesOf(t).filter(([id, r]) => r.Type === 'Custom::DeclaredAssistants' && idPrefix.test(id));
  expect(seeds).toHaveLength(1);
  return { id: seeds[0][0], declaration: JSON.parse(String(seeds[0][1].Properties!.declaration)) };
}

function seedRoleStatements(t: { Resources: Record<string, Resource> }, seedConstructId: string): Statement[] {
  const roles = resourcesOf(t).filter(([id, r]) => r.Type === 'AWS::IAM::Role' && id.startsWith(`${seedConstructId}Role`));
  expect(roles).toHaveLength(1);
  return (roles[0][1].Properties!.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement as Statement[]);
}

describe.each([
  ['the premium classification', premium],
  ['the admin backend', admin],
])('%s', (_label, template) => {
  it('creates, names and records no assistant identity', () => {
    for (const [id, r] of resourcesOf(template)) {
      const props = text(r.Properties ?? {});
      // No identity or Lex bot custom resource: the old provisioners took `botName` / `lexBotAliasArn` / `tier`.
      if (r.Type.startsWith('Custom::') || r.Type === 'AWS::CloudFormation::CustomResource') {
        expect({ id, props }).not.toEqual({ id, props: expect.stringMatching(/"(botName|lexBotAliasArn|tier)"/) });
      }
      if (r.Type === 'AWS::SSM::Parameter') {
        // No assignment record and no name applier pointer.
        expect({ id, name: text(r.Properties!.Name) }).not.toEqual({ id, name: expect.stringMatching(/assistant-assignments|name-applier-arn/) });
      }
      if (r.Type === 'AWS::Lambda::Function') {
        expect({ id, applier: /ApplyAssistantName/.test(id) }).toEqual({ id, applier: false });
      }
    }
  });
});

describe('the premium classification declares its assistants to one seed', () => {
  const { id, declaration } = seedOf(premium);

  it('names its primary and each deployed role, each with how it joins', () => {
    expect(declaration.classification).toBe('premium');
    expect(declaration.roles).toEqual([...profiles.rolesFor('premium')].sort());
    expect(declaration.assistants).toEqual([
      expect.objectContaining({ assistantId: profiles.roleAssistantName('premium', 'primary'), role: 'primary', occupancy: 'live', welcome: true }),
      expect.objectContaining({ assistantId: 'ops-premium', role: 'ops', occupancy: 'live', welcome: true, displayName: 'Ops' }),
    ]);
  });

  it("declares the duel's alt on the same seed in a resource of its own, so declaring battle changes no resource the stack had", () => {
    const alts = seedOf(premium, /^DeclaredDuelAlts/).declaration;
    expect(alts.assistants).toEqual([{ assistantId: 'alt-primary-premium', role: 'primary', occupancy: 'alt', displayName: 'Alt-premium-primary', welcome: false }]);
    const serviceTokens = resourcesOf(premium).filter(([, r]) => r.Type === 'Custom::DeclaredAssistants').map(([, r]) => text(r.Properties!.ServiceToken));
    expect(new Set(serviceTokens).size).toBe(1);
  });

  it("publishes the primary's identity from the seed's answer, never from a resource it owns", () => {
    const pointer = resourcesOf(premium).find(([, r]) => r.Type === 'AWS::SSM::Parameter' && text(r.Properties!.Name).includes('/assistant/premium/bot-arn'));
    expect(pointer).toBeDefined();
    expect(pointer![1].Properties!.Value).toEqual({ 'Fn::GetAtt': [id, 'PrimaryBotArn'] });
  });

  it("its seed holds three grants: invoking the provisioner, writing a claim under premium's path alone, reading its own stack's status", () => {
    const statements = seedRoleStatements(premium, 'DeclaredAssistants');
    expect(statements.map((s) => ({ actions: actionsOf(s), resource: text(s.Resource) }))).toEqual([
      { actions: ['lambda:InvokeFunction'], resource: expect.stringContaining(`function:${ASSISTANT_PROVISIONER_FUNCTION_NAME}`) },
      { actions: ['ssm:PutParameter', 'ssm:DeleteParameter'], resource: expect.stringContaining('/provisioner-claims/seed/premium/*') },
      { actions: ['cloudformation:DescribeStacks'], resource: text({ Ref: 'AWS::StackId' }) },
    ]);
  });

  it('its seed names the classification it serves and its router, which the provisioner holds the request to', () => {
    const fn = resourcesOf(premium).find(([rid, r]) => r.Type === 'AWS::Lambda::Function' && rid.startsWith('DeclaredAssistantsFunction'));
    expect(fn![1].Properties!.Environment.Variables).toEqual({
      CLASSIFICATION: 'premium',
      FULFILLMENT_ARN: expect.anything(),
      PROVISIONER_FUNCTION_NAME: ASSISTANT_PROVISIONER_FUNCTION_NAME,
      SSM_ROOT: expect.stringMatching(/^\//),
    });
  });

  it("asks only once premium's registry row is published, so the row the provisioner reads is this deploy's", () => {
    const row = resourcesOf(premium).find(([, r]) => r.Type === 'AWS::SSM::Parameter' && /profile-registry|registry/.test(text(r.Properties!.Name)) && text(r.Properties!.Name).endsWith('/premium"'));
    expect(row).toBeDefined();
    for (const [rid, r] of resourcesOf(premium).filter(([, x]) => x.Type === 'Custom::DeclaredAssistants')) {
      expect({ rid, dependsOn: (r as { DependsOn?: string[] }).DependsOn ?? [] }).toEqual({ rid, dependsOn: expect.arrayContaining([row![0]]) });
    }
  });

  it('holds no Amazon Lex runtime role or conversation log group: every bot runs as the provisioner\'s', () => {
    expect(resourcesOf(premium).filter(([rid, r]) => /LexBotRole|LexConversationLogs/.test(rid) && r.Type !== 'AWS::CDK::Metadata').map(([rid]) => rid)).toEqual([]);
    expect(resourcesOf(admin).filter(([rid]) => /AdminAgentLexRole/.test(rid)).map(([rid]) => rid)).toEqual([]);
  });
});

describe('the admin backend declares the admin assistant to its seed', () => {
  const { id, declaration } = seedOf(admin);
  const adminPlane = profiles.adminPlaneValues()[0];

  it('as the admin plane primary, silent when it joins', () => {
    expect(declaration).toEqual({
      classification: adminPlane,
      roles: ['primary'],
      assistants: [{ assistantId: profiles.requireProfileFor(adminPlane).name, role: 'primary', occupancy: 'live', displayName: 'Admin Assistant', welcome: false }],
    });
  });

  it("reads the admin assistant's identity from the seed's answer", () => {
    const pointer = resourcesOf(admin).find(([, r]) => r.Type === 'AWS::SSM::Parameter' && text(r.Properties!.Name).includes('/assistant/admin-agent/bot-arn'));
    expect(pointer![1].Properties!.Value).toEqual({ 'Fn::GetAtt': [id, 'PrimaryBotArn'] });
  });
});
