/**
 * BattleStack synthesis: the battle-outcome Lambda's attribution wiring.
 *
 * A `/battle` pick is only useful if it can be joined back to the experiment it was cast in. The
 * handler resolves that experimentId from the channel's battle config SERVER-side (the client is
 * never trusted to attribute its own pick), which means the outcome Lambda needs both the config
 * table name in its environment and read access to it.
 *
 * Neither is exercised by a handler unit test: `loadChannelBattleConfig` fails OPEN, returning null
 * when the table is unset. So with the grant missing the code path still "passes" everywhere while
 * every recorded pick lands with no experimentId - and the analytics scan, which filters picks by
 * experimentId, silently counts zero battle wins. That is a wiring defect only synthesis can catch,
 * so it is pinned here.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BattleStack } from '../lib/stacks/battle-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const props = {
  env,
  appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/11111111-2222-3333-4444-555555555555',
  userPoolId: 'us-east-1_TESTPOOL',
  appUrl: 'https://example.test',
};

function synth() {
  const app = new cdk.App();
  return Template.fromStack(new BattleStack(app, 'TestBattle', props));
}

/** The one Lambda whose entry is battle-outcome-api. */
function outcomeFunction(template: Template): { logicalId: string; fn: any } {
  const fns = template.findResources('AWS::Lambda::Function');
  const entries = Object.entries(fns).filter(
    ([logicalId]) => /BattleOutcomeFunction/.test(logicalId),
  );
  expect(entries).toHaveLength(1);
  const [logicalId, fn] = entries[0];
  return { logicalId, fn };
}

describe('BattleStack — battle-outcome experiment attribution wiring', () => {
  it('gives the outcome Lambda the channel battle config table name', () => {
    const { fn } = outcomeFunction(synth());
    const envVars = fn.Properties.Environment.Variables;

    // Without this the handler reads an unset table and records every pick unattributed.
    expect(Object.keys(envVars)).toContain('CHANNEL_BATTLE_CONFIG_TABLE');
    expect(envVars.CHANNEL_BATTLE_CONFIG_TABLE).toBeDefined();
  });

  it('points that variable at the config table the channel-battle API writes', () => {
    const template = synth();
    const { fn } = outcomeFunction(template);

    // Resolve the Ref to a logical id and confirm it is the ChannelBattleConfigTable itself, not
    // some other table: a name that points at the wrong table reads exactly like a correct one.
    const ref = fn.Properties.Environment.Variables.CHANNEL_BATTLE_CONFIG_TABLE.Ref;
    expect(ref).toBeDefined();
    expect(ref).toMatch(/ChannelBattleConfigTable/);
    expect(template.toJSON().Resources[ref].Type).toBe('AWS::DynamoDB::Table');
  });

  it('grants the outcome role read on the config table', () => {
    const template = synth();

    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: 'dynamodb:GetItem',
                Effect: 'Allow',
                Resource: Match.objectLike({
                  'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('ChannelBattleConfigTable')]),
                }),
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  it('keeps that grant read-only — the outcome path never writes channel battle config', () => {
    const template = synth();
    const roles = template.findResources('AWS::IAM::Role');
    const outcomeRole = Object.entries(roles).find(([logicalId]) =>
      /BattleOutcomeRole/.test(logicalId),
    );
    expect(outcomeRole).toBeDefined();

    const statements = (outcomeRole![1] as any).Properties.Policies.flatMap(
      (p: any) => p.PolicyDocument.Statement,
    );
    const configStatements = statements.filter((s: any) =>
      JSON.stringify(s.Resource).includes('ChannelBattleConfigTable'),
    );
    expect(configStatements.length).toBeGreaterThan(0);

    for (const s of configStatements) {
      const actions: string[] = Array.isArray(s.Action) ? s.Action : [s.Action];
      expect(actions).toEqual(['dynamodb:GetItem']);
    }
  });
});
