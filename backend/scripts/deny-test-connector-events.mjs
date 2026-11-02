#!/usr/bin/env node
/**
 * DENY-TEST: A VENDOR EVENT REACHES THE RECEIVER ONLY THROUGH ITS CONNECTOR'S RULE, AND NO ROUTE SERVES A
 * VENDOR (K5).
 *
 * Against the DEPLOYED `Connectors` stack. The subscribing connectors are read from the deployed receiver's
 * own configuration (`CONNECTORS`), so a connector added later is covered without an edit here, and each
 * expected pattern is computed by the same function the stack builds the rule from
 * (`connectorEventPattern`, `lib/config/connectors.ts`). For each subscribing connector:
 *
 *   1. ITS RULE exists on the partner event bus its `eventSource` names, and its deployed pattern is exactly
 *      the expected one: the declared source, and the subscribed event types where the vendor puts them.
 *   2. The rule has ONE target, the receiver, with a retry policy and a dead-letter queue.
 *   3. An event from ANOTHER source does not match the deployed pattern, and neither does an event type the
 *      connector does not subscribe to (`events:TestEventPattern`, evaluated by EventBridge itself).
 *   4. CONTROL: a subscribed event from the declared source DOES match. A pattern that matches nothing
 *      would pass 3 while proving nothing, so a refused control fails the run.
 *
 * And once:
 *
 *   5. THE RECEIVER'S RESOURCE POLICY admits `lambda:InvokeFunction` to `events.amazonaws.com` only, each
 *      statement conditioned on one of those rules' ARNs, and the set of ARNs is exactly the rules of 1.
 *   6. NO VENDOR ROUTE: the `Connectors` stack holds no HTTP API or route, and no `IngressApi` stack exists
 *      for this instance (`IngressApi` is NOT BUILT).
 *   7. The receiver is this instance's (`ALERT_INSTANCE` equals the resolved instance name), so the checks
 *      above read the deployment that was named.
 *
 * Nothing is sent to a vendor and nothing is put on a bus: a partner event bus accepts events only from its
 * partner. The replay record and K2 (a person is named only through `Identities`, never by email) are
 * proven by the unit tests; a real Salesforce Event Relay or PagerDuty EventBridge delivery, which proves
 * them live, is NOT VERIFIED until the vendor accounts exist.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-connector-events.mjs
 *
 * Needs: the backend built (`npm run build`), and a deployment declaring a connector that subscribes, whose
 * partner event source the operator associated with its event bus before the deploy.
 *
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error.
 */
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { EventBridgeClient, DescribeRuleCommand, ListTargetsByRuleCommand, TestEventPatternCommand } from '@aws-sdk/client-eventbridge';
import { LambdaClient, GetFunctionConfigurationCommand, GetPolicyCommand } from '@aws-sdk/client-lambda';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { VENDORS, connectorEventPattern } = require('../lib/config/connectors.js');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);

const cfn = new CloudFormationClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const sts = new STSClient({ region: REGION });

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };

/** JSON with every object's keys sorted and every array sorted, so two equal patterns compare equal. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical).map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** An event of the vendor's shape, from `source`, of `type`. */
function sampleEvent(account, connector, source, type) {
  const def = VENDORS[connector.vendor];
  const base = { id: '00000000-0000-0000-0000-000000000000', account, region: REGION, time: new Date().toISOString(), resources: [], source };
  return def.eventSource.typeAt === 'detail-type'
    ? { ...base, 'detail-type': type, detail: { id: 'deny-test', payload: {} } }
    : { ...base, 'detail-type': def.eventSource.detailType, detail: { id: 'deny-test', event: type, incident: { id: 'QDENYTEST' } } };
}

/** An event type the vendor sends that the connector does not subscribe to, or null. */
function unsubscribedType(connector) {
  const def = VENDORS[connector.vendor];
  const candidates = Array.isArray(def.events) ? def.events : ['DenyTestUnsubscribed__e', 'DenyTestUnsubscribedChangeEvent'];
  return candidates.find((t) => !connector.subscribes.includes(t)) ?? null;
}

async function matches(pattern, event) {
  return (await eb.send(new TestEventPatternCommand({ EventPattern: pattern, Event: JSON.stringify(event) }))).Result === true;
}

async function main() {
  const account = (await sts.send(new GetCallerIdentityCommand({}))).Account;
  const resources = (await cfn.send(new DescribeStackResourcesCommand({ StackName: `${PREFIX}Connectors` }))).StackResources || [];
  const fnResource = resources.find((r) => r.ResourceType === 'AWS::Lambda::Function' && /^ConnectorEventReceiver/.test(r.LogicalResourceId));
  if (!fnResource) { console.error(`${PREFIX}Connectors has no connector event receiver: no declared connector subscribes`); process.exit(2); }
  const conf = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fnResource.PhysicalResourceId }));
  const receiverArn = conf.FunctionArn;
  const env = conf.Environment?.Variables || {};
  const subscribing = JSON.parse(env.CONNECTORS || '[]').filter((c) => c.subscribes?.length);
  if (!subscribing.length) { console.error('the receiver is configured with no subscribing connector'); process.exit(2); }

  env.ALERT_INSTANCE === INSTANCE
    ? pass(`the receiver is instance ${INSTANCE}'s`)
    : fail(`the receiver names instance "${env.ALERT_INSTANCE}", and the run names "${INSTANCE}"`);

  // The rules, as the stack recorded them: `<bus name>|<rule name>` physical ids.
  const ruleResources = resources.filter((r) => r.ResourceType === 'AWS::Events::Rule' && /^ConnectorEvents/.test(r.LogicalResourceId));
  const ruleArns = [];
  for (const connector of subscribing) {
    console.log(`${connector.id} (${connector.vendor}, ${connector.eventSource})`);
    const expected = connectorEventPattern(connector);
    const rule = ruleResources.map((r) => r.PhysicalResourceId).find((id) => id.startsWith(`${connector.eventSource}|`));
    if (!rule) { fail(`no rule on the partner event bus ${connector.eventSource}`); continue; }
    const name = rule.slice(connector.eventSource.length + 1);
    const described = await eb.send(new DescribeRuleCommand({ Name: name, EventBusName: connector.eventSource }));
    ruleArns.push(described.Arn);
    const deployed = JSON.parse(described.EventPattern || '{}');
    same(deployed, expected)
      ? pass('the rule\'s pattern is the declared source and the subscribed events, exactly')
      : fail(`the rule's pattern is ${described.EventPattern}, and the declaration gives ${JSON.stringify(expected)}`);
    described.State === 'ENABLED' ? pass('the rule is enabled') : fail(`the rule is ${described.State}`);

    const targets = (await eb.send(new ListTargetsByRuleCommand({ Rule: name, EventBusName: connector.eventSource }))).Targets || [];
    if (targets.length === 1 && targets[0].Arn === receiverArn) pass('its one target is the receiver');
    else fail(`the rule has ${targets.length} target(s): ${targets.map((t) => t.Arn).join(', ')}`);
    targets[0]?.DeadLetterConfig?.Arn && targets[0]?.RetryPolicy?.MaximumRetryAttempts > 0
      ? pass('the target has a retry policy and a dead-letter queue')
      : fail('the target has no retry policy or no dead-letter queue');

    const pattern = described.EventPattern || '{}';
    const subscribed = connector.subscribes[0];
    const foreign = `${VENDORS[connector.vendor].eventSource.prefix}deny-test-foreign`;
    (await matches(pattern, sampleEvent(account, connector, foreign, subscribed)))
      ? fail(`an event from ${foreign} MATCHES the rule`)
      : pass('an event from another source of the same vendor does not match');
    (await matches(pattern, sampleEvent(account, connector, 'aws.deny-test', subscribed)))
      ? fail('an event from a non-partner source MATCHES the rule')
      : pass('an event from a non-partner source does not match');
    const other = unsubscribedType(connector);
    if (other) {
      (await matches(pattern, sampleEvent(account, connector, connector.eventSource, other)))
        ? fail(`an unsubscribed event type (${other}) MATCHES the rule`)
        : pass(`an unsubscribed event type (${other}) does not match`);
    }
    (await matches(pattern, sampleEvent(account, connector, connector.eventSource, subscribed)))
      ? pass(`CONTROL: a subscribed event (${subscribed}) from the declared source matches`)
      : fail('CONTROL: a subscribed event from the declared source does not match; the refusals above prove nothing');
  }

  // 5. THE RECEIVER'S RESOURCE POLICY.
  console.log('the receiver\'s resource policy');
  let statements = [];
  try {
    statements = JSON.parse((await lambda.send(new GetPolicyCommand({ FunctionName: receiverArn }))).Policy || '{}').Statement || [];
  } catch (err) {
    if (err?.name !== 'ResourceNotFoundException') throw err;
  }
  const admitted = [];
  for (const s of statements) {
    const principal = s.Principal?.Service;
    const source = s.Condition?.ArnLike?.['AWS:SourceArn'];
    const ok = s.Effect === 'Allow' && principal === 'events.amazonaws.com' && s.Action === 'lambda:InvokeFunction' && typeof source === 'string' && !source.includes('*');
    ok ? admitted.push(source) : fail(`a statement admits more than one rule: ${JSON.stringify(s)}`);
  }
  same(admitted, ruleArns)
    ? pass(`the receiver may be invoked by its ${ruleArns.length} rule(s) and nothing else`)
    : fail(`the receiver admits ${JSON.stringify(admitted.sort())}, and its rules are ${JSON.stringify(ruleArns.sort())}`);

  // 6. NO VENDOR ROUTE.
  const http = resources.filter((r) => /^AWS::ApiGatewayV2::/.test(r.ResourceType));
  http.length ? fail(`the Connectors stack holds ${http.map((r) => r.ResourceType).join(', ')}`) : pass('the Connectors stack holds no HTTP API or route');
  try {
    await cfn.send(new DescribeStacksCommand({ StackName: `${PREFIX}IngressApi` }));
    fail(`${PREFIX}IngressApi exists: no vendor route is built`);
  } catch (err) {
    if (err?.name === 'ValidationError' && /does not exist/.test(String(err?.message))) pass('no IngressApi stack exists for this instance');
    else throw err;
  }

  console.log(failures.length ? `\n${failures.length} gap(s)` : '\nevery refusal held');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  // CloudFormation answers a stack that is not deployed with a ValidationError ("Stack with id X does not exist").
  // `Connectors` is a declared capability, so its absence means this instance does not declare connectors.
  if (err?.name === 'ValidationError' && /does not exist/.test(err.message || '')) {
    const missing = /Stack with id (\S+) does not exist/.exec(err.message)?.[1] || 'a stack';
    console.error(`setup error: ${missing} is not deployed${missing === `${PREFIX}Connectors` ? '; this instance declares no connectors capability' : ''}`);
  } else {
    console.error('setup error:', err?.name || err, err?.message || '');
  }
  process.exit(2);
});
