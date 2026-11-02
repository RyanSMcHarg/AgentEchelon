/**
 * AN ASSISTANT'S AWS LINKS NAME THE LIVE RESOURCES OF ITS OWN CLASSIFICATION (`lib/profile-infra.ts`).
 *
 * The stack publishes the processor, router and vend under `/assistant/{classification}/` (`processorArnKey`,
 * `routerArnKey` in agent-classification-common.ts). The resolver used to read them under the assistant's own
 * name, which is the classification only by coincidence, so `advisor`, `ops-premium` and every console-created
 * assistant got no link at all. This holds the resolver to the stack's real layout, by importing the stack's
 * own key builders rather than restating the paths.
 */
import { processorArnKey, routerArnKey, SSM_ROOT } from '../../lib/stacks/agent-classification-common';
import { createInfraResolver } from '../../lambda/src/lib/profile-infra';

const ACCOUNT = '111122223333';
const APP = `arn:aws:chime:us-east-1:${ACCOUNT}:app-instance/app-1`;
const fn = (name: string) => `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${name}`;
const ACTING_ROLE = `arn:aws:iam::${ACCOUNT}:role/agent-echelon/assistant/AgentEchelonAssistants-pr-AssistantActingRoleF4D898-abc`;
const BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy/AgentEchelonAssistantActingBoundary-premium`;

/** The parameters a deployed premium classification stack writes, under the keys the stack builds. */
const params: Record<string, string> = {
  [processorArnKey('premium')]: fn('AgentEchelonAssistants-prem-AsyncProcessor-1'),
  [routerArnKey('premium')]: fn('AgentEchelonAssistants-premiu-AgentHandler-1'),
  [`${SSM_ROOT}/assistant/premium/vend-arn`]: fn('AgentEchelonAssistants-prem-AssistantVend-1'),
  [`${SSM_ROOT}/assistant/premium/guardrails`]: JSON.stringify([
    { key: 'default', name: 'agent-echelon-premium-guardrail', guardrailId: 'gr-default', guardrailVersion: '1' },
    { key: 'strict', name: 'agent-echelon-premium-strict-guardrail', guardrailId: 'gr-strict', guardrailVersion: '1' },
  ]),
  [`${SSM_ROOT}/channel-flow-arn`]: `${APP}/channel-flow/flow-1`,
};

const functions: Record<string, Record<string, string>> = {
  [fn('AgentEchelonAssistants-prem-AsyncProcessor-1')]: { GUARDRAIL_ID: 'gr-default' },
  [fn('AgentEchelonAssistants-prem-AssistantVend-1')]: { ACTING_ROLE_ARN: ACTING_ROLE },
};

const bots: Record<string, { botId: string; aliasId: string }> = {
  [`${APP}/bot/advisor`]: { botId: 'LEXADVISOR', aliasId: 'TSTALIASID' },
  [`${APP}/bot/ops`]: { botId: 'LEXOPS', aliasId: 'TSTALIASID' },
  [`${APP}/bot/runtime`]: { botId: 'LEXRUNTIME', aliasId: 'TSTALIASID' },
};

type Cmd = { constructor: { name: string }; input: Record<string, any> };

function clients() {
  const ssmNames: string[] = [];
  const notFound = () => Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
  return {
    ssmNames,
    clients: {
      ssm: { send: jest.fn(async (c: Cmd) => {
        ssmNames.push(c.input.Name);
        if (!(c.input.Name in params)) throw notFound();
        return { Parameter: { Value: params[c.input.Name] } };
      }) },
      lambda: { send: jest.fn(async (c: Cmd) => ({ Environment: { Variables: functions[c.input.FunctionName] ?? {} } })) },
      chimeIdentity: { send: jest.fn(async (c: Cmd) => {
        const b = bots[c.input.AppInstanceBotArn];
        return { AppInstanceBot: { Configuration: { Lex: { LexBotAliasArn: `arn:aws:lex:us-east-1:${ACCOUNT}:bot-alias/${b.botId}/${b.aliasId}` } } } };
      }) },
      chimeMessaging: { send: jest.fn(async () => ({
        ChannelFlow: { Processors: [{ Configuration: { Lambda: { ResourceArn: fn('AgentEchelonChannelFlow-Processor-1') } } }] },
      })) },
      lex: { send: jest.fn(async () => ({
        conversationLogSettings: { textLogSettings: [{ enabled: true, destination: { cloudWatch: {
          cloudWatchLogGroupArn: `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:AgentEchelonAssistants-premium-LexConversationLogs-1:*`,
        } } }] },
      })) },
      iam: { send: jest.fn(async () => ({ Role: { PermissionsBoundary: { PermissionsBoundaryArn: BOUNDARY } } })) },
    } as any,
  };
}

const opts = { ssmRoot: SSM_ROOT, region: 'us-east-1', bodyBucket: 'bodies' };

describe('an assistant\'s links name its own classification\'s resources', () => {
  const cases = [
    // ONE RESOLUTION PATH FOR EVERY ASSISTANT (ADR-048, amended 2026-10-23): declared or created in the console,
    // each is the provisioner's, with a directory entry and a record at the same path family.
    { label: 'a declared primary', name: 'advisor', placement: { classification: 'premium', role: 'primary', provisioned: true, botArns: [`${APP}/bot/advisor`] }, lex: 'LEXADVISOR',
      assignment: `${SSM_ROOT}/assistant-assignments/premium/primary/assistants/advisor` },
    { label: 'an additional role', name: 'ops-premium', placement: { classification: 'premium', role: 'ops', provisioned: true, botArns: [`${APP}/bot/ops`] }, lex: 'LEXOPS',
      assignment: `${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium` },
    { label: 'a console-created assistant', name: 'helper-one', placement: { classification: 'premium', role: 'primary', provisioned: true, botArns: [`${APP}/bot/runtime`] }, lex: 'LEXRUNTIME',
      assignment: `${SSM_ROOT}/assistant-assignments/premium/primary/assistants/helper-one` },
  ];

  it.each(cases)('$label resolves the processor, router, acting role, boundary and guardrail', async ({ name, placement, lex, assignment }) => {
    const { clients: c, ssmNames } = clients();
    const r = await createInfraResolver(c, opts)(name, placement);

    expect(r.processorFunctionName).toBe('AgentEchelonAssistants-prem-AsyncProcessor-1');
    expect(r.routerFunctionName).toBe('AgentEchelonAssistants-premiu-AgentHandler-1');
    expect(r.actingRoleArn).toBe(ACTING_ROLE);
    expect(r.actingRoleName).toBe('AgentEchelonAssistants-pr-AssistantActingRoleF4D898-abc');
    expect(r.boundaryPolicyArn).toBe(BOUNDARY);
    expect(r.guardrailId).toBe('gr-default');
    expect(r.guardrailName).toBe('agent-echelon-premium-guardrail');
    // Its own resources.
    expect(r.lexBotId).toBe(lex);
    expect(r.lexBotAliasId).toBe('TSTALIASID');
    expect(r.assignmentParam).toBe(assignment);
    expect(r.directoryParam).toBe(`${SSM_ROOT}/assistant-directory/${name}`);
    expect(r.definitionParam).toBe(`${SSM_ROOT}/assistant/${name}/definition`);
    expect(r.profileBodies).toEqual({ bucket: 'bodies', prefix: `profiles/${name}/` });
    expect(r.templates).toEqual({ bucket: 'bodies', prefix: 'templates/premium/' });
    expect(r.lexLogGroup).toBe('AgentEchelonAssistants-premium-LexConversationLogs-1');
    // The deployment's channel flow and the exact Lambda it invokes.
    expect(r.channelFlowProcessorFunctionName).toBe('AgentEchelonChannelFlow-Processor-1');

    // Shared resources say they are shared.
    expect(r.scopes.processorArn).toBe('classification');
    expect(r.scopes.actingRoleArn).toBe('classification');
    expect(r.scopes.lexBotId).toBe('assistant');
    expect(r.scopes.channelFlowArn).toBe('deployment');

    // Never under the assistant's own name: that key does not exist.
    expect(ssmNames).not.toContain(`${SSM_ROOT}/assistant/${name}/processor-arn`);
    expect(ssmNames).not.toContain(`${SSM_ROOT}/assistant/${name}/router-arn`);
  });

  it('reads each classification\'s shared resources once per listing', async () => {
    const { clients: c, ssmNames } = clients();
    const resolve = createInfraResolver(c, opts);
    await Promise.all(cases.map((k) => resolve(k.name, k.placement)));
    expect(ssmNames.filter((n) => n === processorArnKey('premium'))).toHaveLength(1);
  });

  it('a failed read drops its link and nothing else', async () => {
    const { clients: c } = clients();
    c.iam.send = jest.fn(async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); });
    const r = await createInfraResolver(c, opts)('advisor', cases[0].placement);
    expect(r.boundaryPolicyArn).toBeUndefined();
    expect(r.actingRoleArn).toBe(ACTING_ROLE);
    expect(r.processorArn).toBeDefined();
  });

  it('an assistant with no known classification still names its own definition, and nothing shared', async () => {
    const { clients: c } = clients();
    const r = await createInfraResolver(c, opts)('unknown');
    expect(r.definitionParam).toBe(`${SSM_ROOT}/assistant/unknown/definition`);
    expect(r.processorArn).toBeUndefined();
  });
});
