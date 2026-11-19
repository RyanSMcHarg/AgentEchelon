/**
 * HANDS A TRIGGER'S EVENT TO ITS CLASSIFICATION'S ROUTER (SPEC-WORKFLOWS-AND-TASKS WT121). An EventBridge rule is a
 * service principal, and the router's resource policy admits only its two (Amazon Lex and the incident-watch rule); every other
 * caller holds an identity grant naming the router. This function is that caller for a rule the console attaches.
 * It reads nothing and decides nothing: the router verifies the room, the rule and the workflow before anything runs.
 */
import { InvocationType, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});

export const handler = async (event: { aeRuleEvent?: unknown; aeWatchEvent?: unknown }): Promise<void> => {
  // A TEAM-ROOM RULE'S EVENT, OR A WATCH RULE'S (DESIGN-EVENT-TARGETS): passed on as it came, one kind per invocation.
  const payload = event?.aeRuleEvent ? { aeRuleEvent: event.aeRuleEvent } : event?.aeWatchEvent ? { aeWatchEvent: event.aeWatchEvent } : undefined;
  if (!payload) return;
  await lambda.send(new InvokeCommand({
    FunctionName: process.env.ROUTER_ARN,
    InvocationType: InvocationType.Event,
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
};
