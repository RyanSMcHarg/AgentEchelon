#!/usr/bin/env node
/**
 * DENY-TEST: A CROSSING NEITHER TEAM APPROVED IS REFUSED ON THE DEPLOYMENT (SPEC-PROCESSES P4, P6, P7; DESIGN-PROCESSES
 * sections 4.3 and 12).
 *
 * Against the DEPLOYED stacks. Run as an operator principal that is neither a router role nor the trigger service's role.
 *
 *   1. THE PROCESS EVENT BUS'S POLICY, read back: each classification's process source is denied to every principal but its
 *      router role (by ARN), every other source is denied, and rule and target writes are denied to every principal but the
 *      trigger service's role.
 *   2. PUT BY ANOTHER PRINCIPAL: this operator puts `ae.process.<c>` on the bus, for every classification, and is refused. The
 *      entry names an instance no rule matches, so a put that a gap let through still starts nothing.
 *   3. SUBSCRIBE BY ANOTHER PRINCIPAL: this operator writes a rule on the bus and is refused (a rule a gap let through is
 *      removed again at once).
 *   4. IAM, LAYER TWO: each router role may put its own process source on the bus and is refused another classification's and
 *      the default bus (`iam:SimulatePrincipalPolicy`). The allowed put is the control: a role that may put nothing would pass
 *      the refusal while proving nothing.
 *   5. EVERY ATTACHED HAND-OFF (each rule of this instance on the bus): the rule matches exactly what was attached
 *      (`events:TestEventPattern`), and the receiving router, invoked with the rule's own input as the relay hands it, starts no
 *      run for fields that differ from the declaration recorded at attach, a `detail-type` that disagrees with its process, and,
 *      on a watched target, a hand-off of another process.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-process-handoffs.mjs
 *
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error.
 */
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import {
  DeleteRuleCommand, DescribeEventBusCommand, EventBridgeClient, ListRulesCommand, ListTargetsByRuleCommand, PutEventsCommand, PutRuleCommand, TestEventPatternCommand,
} from '@aws-sdk/client-eventbridge';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
const BUS = `${PREFIX}-process`;
const CLASSIFICATIONS = (process.env.AE_CLASSIFICATIONS || 'basic,standard,premium').split(',').map((c) => c.trim()).filter(Boolean);
const cfn = new CloudFormationClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const sts = new STSClient({ region: REGION });

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const setup = (m) => { console.error(`SETUP: ${m}`); process.exit(2); };

const me = await sts.send(new GetCallerIdentityCommand({}));
const account = me.Account;
const routerRole = (c) => `arn:aws:iam::${account}:role/${PREFIX}-router-${c}`;
const triggersRole = `arn:aws:iam::${account}:role/${PREFIX}-event-triggers`;
if (/:assumed-role\/[^/]*-(router-[a-z0-9-]+|event-triggers)\//.test(me.Arn ?? '')) setup('run this as an operator, not as a router role or the trigger service\'s role');
console.log(`instance ${INSTANCE}, bus ${BUS}, caller ${me.Arn}`);

// 1. The bus's policy, read back.
const bus = await eb.send(new DescribeEventBusCommand({ Name: BUS })).catch(() => setup(`no event bus ${BUS}; deploy the Messaging stack first`));
const statements = JSON.parse(bus.Policy ?? '{"Statement":[]}').Statement ?? [];
const denies = statements.filter((s) => s.Effect === 'Deny');
statements.every((s) => s.Effect === 'Deny') ? pass('the bus policy only denies') : fail('the bus policy allows something');
for (const c of CLASSIFICATIONS) {
  const s = denies.find((x) => x.Condition?.StringEquals?.['events:source'] === `ae.process.${c}`);
  s && s.Condition?.ArnNotEquals?.['aws:PrincipalArn'] === routerRole(c)
    ? pass(`ae.process.${c} is denied to all but ${PREFIX}-router-${c}`) : fail(`no deny of ae.process.${c} to all but its router role`);
}
denies.some((x) => x.Condition?.StringNotLike?.['events:source'] === 'ae.process.*') ? pass('every other source is denied') : fail('another source is not denied');
const sub = denies.find((x) => [x.Action].flat().includes('events:PutRule'));
sub && sub.Condition?.ArnNotEquals?.['aws:PrincipalArn'] === triggersRole ? pass('rule writes are denied to all but the trigger service') : fail('rule writes are not pinned to the trigger service');

// 2. A put of each process source by this operator is refused.
for (const c of CLASSIFICATIONS) {
  const res = await eb.send(new PutEventsCommand({ Entries: [{
    EventBusName: BUS, Source: `ae.process.${c}`, DetailType: 'deny-test.handoff', Detail: JSON.stringify({ instance: `deny-test-${Date.now()}` }),
  }] })).catch((err) => ({ thrown: err.name }));
  const refused = res.thrown || (res.FailedEntryCount ?? 0) > 0;
  refused ? pass(`a put of ae.process.${c} by another principal is refused (${res.thrown ?? res.Entries?.[0]?.ErrorCode})`) : fail(`another principal put ae.process.${c} on the bus`);
}

// 3. A rule written on the bus by this operator is refused.
const probe = `${PREFIX}-deny-test-${Date.now()}`;
const wrote = await eb.send(new PutRuleCommand({ Name: probe, EventBusName: BUS, EventPattern: JSON.stringify({ source: ['ae.process.deny-test'] }), State: 'DISABLED' })).then(() => true, (err) => err.name);
if (wrote === true) {
  fail('another principal wrote a rule on the process bus');
  await eb.send(new DeleteRuleCommand({ Name: probe, EventBusName: BUS })).catch(() => undefined);
} else pass(`a rule written on the bus by another principal is refused (${wrote})`);

// 4. Each router role's own statement: its own source on the bus, nothing else.
const sim = async (role, src, resource) => (await iam.send(new SimulatePrincipalPolicyCommand({
  PolicySourceArn: role, ActionNames: ['events:PutEvents'], ResourceArns: [resource],
  ContextEntries: [{ ContextKeyName: 'events:source', ContextKeyType: 'string', ContextKeyValues: [src] }],
}))).EvaluationResults?.[0]?.EvalDecision;
const busArn = `arn:aws:events:${REGION}:${account}:event-bus/${BUS}`;
const defaultArn = `arn:aws:events:${REGION}:${account}:event-bus/default`;
for (const c of CLASSIFICATIONS) {
  const other = CLASSIFICATIONS.find((x) => x !== c) ?? 'deny-test';
  (await sim(routerRole(c), `ae.process.${c}`, busArn)) === 'allowed' ? pass(`CONTROL: ${c}'s router may put its own source on the bus`) : fail(`${c}'s router may not put its own source`);
  (await sim(routerRole(c), `ae.process.${other}`, busArn)) !== 'allowed' ? pass(`${c}'s router is refused ae.process.${other}`) : fail(`${c}'s router may put ae.process.${other}`);
  (await sim(routerRole(c), `ae.process.${c}`, defaultArn)) !== 'allowed' ? pass(`${c}'s router is refused its process source on the default bus`) : fail(`${c}'s router may put its process source on the default bus`);
}

// 5. Every attached hand-off.
async function stackResource(classification, logicalPrefix) {
  const res = await cfn.send(new DescribeStackResourcesCommand({ StackName: `${PREFIX}Assistants-${classification}` }));
  return (res.StackResources ?? []).find((r) => r.LogicalResourceId?.startsWith(logicalPrefix))?.PhysicalResourceId;
}
function inputFor(transformer, event) {
  const at = (path) => path.replace(/^\$\./, '').split('.').reduce((v, k) => {
    if (v == null) return undefined;
    const m = /^(.+)\[(\d+)\]$/.exec(k);
    return m ? v[m[1]]?.[Number(m[2])] : v[k];
  }, event);
  let text = transformer.InputTemplate;
  for (const [name, path] of Object.entries(transformer.InputPathsMap ?? {})) text = text.split(`<${name}>`).join(JSON.stringify(at(path) ?? null));
  return JSON.parse(text);
}
async function invokeRouter(classification, payload) {
  const fn = await stackResource(classification, 'AgentHandler');
  if (!fn) setup(`no router function in ${PREFIX}Assistants-${classification}`);
  const res = await lambda.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(payload)) }));
  return JSON.parse(Buffer.from(res.Payload ?? []).toString() || '{}');
}
const handoffs = [];
let NextToken;
do {
  const res = await eb.send(new ListRulesCommand({ EventBusName: BUS, NamePrefix: `${PREFIX}-`, NextToken, Limit: 100 }));
  for (const r of res.Rules ?? []) {
    if (!/-(trigger|watch)-[a-f0-9]{12}$/.test(r.Name ?? '')) continue;
    const pattern = JSON.parse(r.EventPattern ?? '{}');
    const target = (await eb.send(new ListTargetsByRuleCommand({ Rule: r.Name, EventBusName: BUS }))).Targets?.[0];
    const receiving = r.Name.slice(`${PREFIX}-`.length).split(/-(?:trigger|watch)-/)[0];
    handoffs.push({ name: r.Name, pattern, source: pattern.source?.[0], detailType: pattern['detail-type']?.[0], watched: /-watch-/.test(r.Name), receiving, transformer: target?.InputTransformer });
  }
  NextToken = res.NextToken;
} while (NextToken);
console.log(`\n${handoffs.length} attached hand-off(s)${handoffs.length ? '' : '; attach one in the console to prove the receiving checks'}`);
for (const h of handoffs) {
  const [process, handoff] = h.detailType.split('.');
  const other = h.source === 'ae.process.deny-test' ? 'ae.process.other' : 'ae.process.deny-test';
  console.log(`\n${h.name}: ${h.detailType} from ${h.source}, received at ${h.receiving}${h.watched ? ' (watched)' : ''}`);
  const recorded = inputFor(h.transformer, { detail: {} });
  const fields = Object.fromEntries(Object.keys((recorded.aeRuleEvent ?? recorded.aeWatchEvent)?.handoff?.attached?.fields ?? {}).map((k) => [k, null]));
  const event = (over = {}) => ({ id: '0', account, region: REGION, time: new Date().toISOString(), resources: [], source: h.source, 'detail-type': h.detailType, detail: { instance: INSTANCE, processId: 'ffffffffffff', process, handoff, fields }, ...over });
  const matches = async (e) => (await eb.send(new TestEventPatternCommand({ EventPattern: JSON.stringify(h.pattern), Event: JSON.stringify(e) }))).Result;
  (await matches(event())) ? pass('CONTROL: the attached event matches the rule') : fail('the attached event does not match its own rule');
  !(await matches(event({ source: other }))) ? pass(`an event from ${other} does not match`) : fail(`an event from ${other} matches`);
  !(await matches(event({ 'detail-type': `${process}.not-attached` }))) ? pass('a hand-off nobody attached does not match') : fail('an unattached hand-off matches');
  const changed = event({ detail: { ...event().detail, fields: { ...fields, added: 'x' } } });
  const disagrees = event({ detail: { ...event().detail, process: 'another-process' } });
  for (const [label, e] of [['fields that differ from the attached declaration', changed], ['a detail-type that disagrees with its process', disagrees], ...(h.watched ? [['a hand-off of another process at the watched target', event()]] : [])]) {
    const out = await invokeRouter(h.receiving, inputFor(h.transformer, e));
    out && out.ran === false ? pass(`${label}: no run (${out.reason})`) : fail(`${label}: the router answered ${JSON.stringify(out)}`);
  }
}

console.log(failures.length ? `\n${failures.length} refusal(s) did not hold` : '\nevery refusal held');
process.exit(failures.length ? 1 : 0);
