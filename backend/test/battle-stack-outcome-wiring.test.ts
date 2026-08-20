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

/**
 * The wiring a duel needs in order to END, which is a different set from the wiring it needs to RUN.
 *
 * Every helper on the ending path fails SOFT when its table is unset - `readBattleRows` returns `[]`,
 * the transitions return `false`, `clearActiveBattle` returns at its first line. That is right at
 * runtime, because cleaning up after a duel must never take down the path that is ending it, and it is
 * exactly what makes the omission invisible: three Lambdas were given code that ends a duel without the
 * table access to do it, and every unit test and end-to-end test still passed. Only synthesis can see
 * it, so it is pinned here.
 */
describe('BattleStack - a duel can actually be ended, not just told to end', () => {
  /** The single Lambda whose logical id matches, plus its env vars. */
  function fnEnv(template: Template, idPattern: RegExp): Record<string, any> {
    const entries = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([logicalId]) => idPattern.test(logicalId));
    expect(entries).toHaveLength(1);
    return (entries[0][1] as any).Properties.Environment.Variables;
  }

  /** Every action a role is granted against a table, flattened across its policies. */
  function actionsOn(template: Template, rolePattern: RegExp, tablePattern: RegExp): string[] {
    const role = Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([logicalId]) => rolePattern.test(logicalId));
    // Plain `toBeDefined`: this suite runs under Jest, whose `expect` takes no message argument.
    // A missing role here means the logical-id pattern has drifted, not that a grant is absent.
    expect(role).toBeDefined();
    const statements = ((role![1] as any).Properties.Policies || [])
      .flatMap((p: any) => p.PolicyDocument.Statement);
    return statements
      .filter((s: any) => tablePattern.test(JSON.stringify(s.Resource)))
      .flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
  }

  it('lets the ORCHESTRATOR release the channel when a duel finishes', () => {
    const template = synth();

    // Finishing a duel releases the `activeBattleId` pointer. Without the name the release returns
    // immediately; without the grant it AccessDenies into a caught warning. Either way the channel
    // stays locked to a duel that is over until the backstop clock expires - the exact behaviour the
    // recorded release replaced.
    expect(fnEnv(template, /BattleOrchestrator/).CHANNEL_BATTLE_CONFIG_TABLE).toBeDefined();
    expect(actionsOn(template, /BattleOrchestratorRole/, /ChannelBattleConfigTable/))
      .toContain('dynamodb:UpdateItem');
  });

  it('lets TURNING BATTLE MODE OFF end the duel that is running, not just release it', () => {
    const template = synth();

    // Ending is four writes and three of them are on the duel's own rows: mark the sides ABANDONED,
    // claim the orchestrator sentinel so no rebuttal is generated, after reading the partition.
    expect(fnEnv(template, /ChannelBattleFunction/).BATTLE_STATE_TABLE).toBeDefined();
    const stateActions = actionsOn(template, /ChannelBattleRole/, /BattleStateTable/);
    expect(stateActions).toEqual(expect.arrayContaining([
      'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:PutItem',
    ]));

    // And UpdateItem on the config table: releasing the pointer is an UPDATE, not the Put/Delete this
    // handler used before it had a duel to end.
    expect(actionsOn(template, /ChannelBattleRole/, /ChannelBattleConfigTable/))
      .toContain('dynamodb:UpdateItem');
  });

  it('lets the PICK API see that a duel was abandoned, and only see it', () => {
    const template = synth();

    // The refusal is what keeps an unfinished comparison out of the human-pick axis. Unset, the read
    // returns [] and the `rows.length > 0` guard makes the whole check unreachable - present in the
    // source, absent in behaviour.
    expect(fnEnv(template, /BattleOutcomeFunction/).BATTLE_STATE_TABLE).toBeDefined();

    // Read-only, deliberately: this Lambda judges a duel, it never changes one.
    expect(actionsOn(template, /BattleOutcomeRole/, /BattleStateTable/)).toEqual(['dynamodb:Query']);
  });
});
