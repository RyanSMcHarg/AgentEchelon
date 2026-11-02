/**
 * EACH AWS CONSOLE LINK IS THE EXACT URL OF ONE RESOURCE, in the region it was resolved in.
 *
 * The CloudWatch fragment is the one that was wrong: a filter's quotes were encoded once (`%22`), which the
 * console reads as a literal and filters nothing. Inside the fragment everything is encoded twice and `%` is
 * written as `$`, so a quote is `$2522` and a slash `$252F`.
 */
import { describe, expect, it } from 'vitest';
import {
  bedrockGuardrailUrl,
  cloudwatchLogGroupUrl,
  cloudwatchLogsUrl,
  describeCommand,
  iamPolicyUrl,
  iamRoleUrl,
  lambdaFunctionUrl,
  lexBotUrl,
  s3PrefixUrl,
  ssmParameterUrl,
} from './awsConsole';

const R = 'eu-west-2';

describe('AWS console links', () => {
  it('a Lambda function, in the region given', () => {
    expect(lambdaFunctionUrl('AgentEchelonAssistants-prem-AsyncProcessor-1', R))
      .toBe('https://eu-west-2.console.aws.amazon.com/lambda/home?region=eu-west-2#/functions/AgentEchelonAssistants-prem-AsyncProcessor-1');
  });

  it('a function\'s log group, with no filter', () => {
    expect(cloudwatchLogsUrl('fn-1', undefined, R))
      .toBe('https://eu-west-2.console.aws.amazon.com/cloudwatch/home?region=eu-west-2#logsV2:log-groups/log-group/$252Faws$252Flambda$252Ffn-1');
  });

  it('a function\'s log events filtered to a quoted term', () => {
    expect(cloudwatchLogsUrl('fn-1', 'web_search', R))
      .toBe('https://eu-west-2.console.aws.amazon.com/cloudwatch/home?region=eu-west-2#logsV2:log-groups/log-group/$252Faws$252Flambda$252Ffn-1/log-events$3FfilterPattern$3D$2522web_search$2522');
  });

  it('a filter term with a space is encoded twice like the rest of the fragment', () => {
    expect(cloudwatchLogGroupUrl('group', 'two words', R)).toContain('$3FfilterPattern$3D$2522two$2520words$2522');
  });

  it('a named log group', () => {
    expect(cloudwatchLogGroupUrl('AgentEchelonAssistants-premium-LexConversationLogs-1', undefined, R))
      .toBe('https://eu-west-2.console.aws.amazon.com/cloudwatch/home?region=eu-west-2#logsV2:log-groups/log-group/AgentEchelonAssistants-premium-LexConversationLogs-1');
  });

  it('a Bedrock guardrail by name and id', () => {
    expect(bedrockGuardrailUrl('agent-echelon-premium-guardrail', 'kypdz9z46oyd', R))
      .toBe('https://eu-west-2.console.aws.amazon.com/bedrock/home?region=eu-west-2#/guardrails/guardrail/agent-echelon-premium-guardrail/kypdz9z46oyd');
  });

  it('an IAM role by name and a policy by ARN (IAM is global)', () => {
    expect(iamRoleUrl('AgentEchelonAssistants-pr-AssistantActingRoleF4D898-abc'))
      .toBe('https://console.aws.amazon.com/iam/home#/roles/details/AgentEchelonAssistants-pr-AssistantActingRoleF4D898-abc');
    expect(iamPolicyUrl('arn:aws:iam::111122223333:policy/AgentEchelonAssistantActingBoundary-premium'))
      .toBe('https://console.aws.amazon.com/iam/home#/policies/details/arn%3Aaws%3Aiam%3A%3A111122223333%3Apolicy%2FAgentEchelonAssistantActingBoundary-premium');
  });

  it('an Amazon Lex V2 bot', () => {
    expect(lexBotUrl('G6RNV0NHHL', R)).toBe('https://eu-west-2.console.aws.amazon.com/lexv2/home?region=eu-west-2#bot/G6RNV0NHHL');
  });

  it('a Systems Manager parameter, without its leading slash', () => {
    expect(ssmParameterUrl('/agent-echelon/assistant/advisor/definition', R))
      .toBe('https://eu-west-2.console.aws.amazon.com/systems-manager/parameters/agent-echelon/assistant/advisor/definition/description?region=eu-west-2&tab=Table');
  });

  it('an S3 prefix', () => {
    expect(s3PrefixUrl('bodies-bucket', 'templates/premium/', R))
      .toBe('https://eu-west-2.console.aws.amazon.com/s3/buckets/bodies-bucket?region=eu-west-2&prefix=templates%2Fpremium%2F&showversions=false');
  });

  it('a channel flow and an AppInstanceBot have no console page, so the CLI describes them', () => {
    const app = 'arn:aws:chime:eu-west-2:111122223333:app-instance/app-1';
    expect(describeCommand(`${app}/channel-flow/flow-1`, R))
      .toBe(`aws chime-sdk-messaging describe-channel-flow --channel-flow-arn ${app}/channel-flow/flow-1 --region eu-west-2`);
    expect(describeCommand(`${app}/bot/bot-1`, R))
      .toBe(`aws chime-sdk-identity describe-app-instance-bot --app-instance-bot-arn ${app}/bot/bot-1 --region eu-west-2`);
  });
});
