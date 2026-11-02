/**
 * EVERY ALARM THE STACKS DECLARE IS ONE THE OPS ASSISTANT CAN READ.
 *
 * `read_deployment_health` asks CloudWatch for the alarms the stacks publish by name (`publishAlarmNames`),
 * and the acting role's `DescribeAlarms` grant names this deployment's alarm ARNs by prefix
 * (`deploymentAlarmNamePrefixes`). A published alarm named any other way would be refused, and fire unseen
 * by the assistant whose job is to report it. So every `alarmName` in
 * `lib/` begins with the stack's own name (`${stackName}-`, which also covers the name CloudFormation
 * generates for an alarm declared without one) or with the instance prefix (`${STACK_PREFIX}-`).
 *
 * The scan reads the `alarmName` of each CloudWatch alarm construct (`new <ns>.Alarm(`, `new <ns>.CfnAlarm(`, or
 * `.createAlarm(`) and nothing else, so an event pattern or an input transformer that mentions an alarm's name is
 * not read as one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { deploymentAlarmNamePrefixes, STACK_PREFIX } from '../../lib/stacks/agent-classification-common';
import { STACK_NAMES } from '../../lib/config/stack-names';

const LIB = path.join(__dirname, '../../lib');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

/** The forms an alarm name may open with: the stack's own name, or the instance prefix. */
const ALLOWED_OPENINGS = /^`\$\{(?:this\.stackName|stack\.stackName|cdk\.Stack\.of\([a-zA-Z]+\)\.stackName|STACK_PREFIX)\}-/;

/** A CloudWatch alarm construct: `new cloudwatch.Alarm(`, `new cw.CfnAlarm(`, or `metric.createAlarm(`. */
const ALARM_CONSTRUCT = /(?:\bnew\s+(?:[A-Za-z_$][\w$]*\.)?(?:Alarm|CfnAlarm)|\.createAlarm)\s*\(/g;

/** The source of the call whose `(` is at `open`, through its matching `)`. */
function callBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced call at offset ${open}`);
}

describe('alarm names carry the deployment prefix', () => {
  const constructs = tsFiles(LIB).flatMap((file) => {
    const src = fs.readFileSync(file, 'utf8');
    return [...src.matchAll(ALARM_CONSTRUCT)].map((m) => {
      const name = /\balarmName:\s*([^,\n]+)/.exec(callBody(src, m.index! + m[0].length - 1));
      return { file: path.relative(LIB, file), expr: name ? name[1].trim() : undefined };
    });
  });
  const declared = constructs.filter((c): c is { file: string; expr: string } => c.expr !== undefined);

  it('finds the alarms the stacks declare', () => {
    expect(constructs.length).toBeGreaterThanOrEqual(19);
    expect(declared.length).toBeGreaterThanOrEqual(18);
    expect(declared.map((d) => d.expr)).toEqual(expect.arrayContaining([
      '`${this.stackName}-context-source-failure-rate`',
      '`${this.stackName}-event-deadline-unscheduled`',
      '`${cdk.Stack.of(scope).stackName}-typed-conversation-events-undelivered`',
      '`${STACK_PREFIX}-channel-flow-processor-errors`',
    ]));
  });

  it('opens every alarm name with the stack name or the instance prefix', () => {
    const outside = declared.filter((d) => !ALLOWED_OPENINGS.test(d.expr));
    expect(outside).toEqual([]);
  });

  it('lists a prefix for every stack this instance can create, and for the instance itself', () => {
    const prefixes = deploymentAlarmNamePrefixes();
    expect(prefixes).toContain(`${STACK_PREFIX}-`);
    for (const name of STACK_NAMES.current) expect(prefixes).toContain(`${STACK_PREFIX}${name}-`);
    expect(prefixes).toContain(`${STACK_PREFIX}${STACK_NAMES.perClassification}`);
    expect(prefixes).toContain(`${STACK_PREFIX}${STACK_NAMES.perRegion}`);
  });
});
