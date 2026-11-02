/**
 * A LOG GROUP ACTION IS GRANTED ON A LOG GROUP ARN.
 *
 * From 2027-04-26 Amazon CloudWatch Logs authorizes Log Group actions only against a Log Group ARN
 * (`arn:aws:logs:<region>:<account>:log-group:<name>`). A Log Stream ARN (`...:log-group:<name>:*` or
 * `...:log-group:<name>:log-stream:<stream>`) grants only the four stream actions: `logs:PutLogEvents`,
 * `logs:GetLogEvents`, `logs:CreateLogStream` and `logs:DeleteLogStream`. A statement that grants any other
 * `logs:` action on a stream-form ARN stops granting it on that date, and nothing at synth or deploy says so.
 *
 * Every Allow statement in every synthesized stack is read: identity policies (inline and `AWS::IAM::Policy`),
 * managed policies (permissions boundaries included) and resource policies (any `Statement` a resource
 * carries, or a JSON policy string). A resource built from `Fn::Join`, `Fn::Sub`, `Fn::GetAtt` or
 * `Fn::ImportValue` is read in its rendered form, with what cannot be resolved kept as an opaque token, so a
 * literal `:log-stream:` or a trailing `:*` after the log group name stays visible. A log group's `Arn`
 * attribute is the stream form (`...:log-group:<name>:*`), so it renders that way.
 *
 * Read from the real app in every variant the API contract synthesizes (both analytics modes, every built
 * capability, each issuer shape, sleep mode).
 */
import * as path from 'path';
import { SYNTH_VARIANTS, synthesizeApp } from '../lib/docs/api-contract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

/** What a Log Stream ARN still grants after 2027-04-26. */
const STREAM_ACTIONS = new Set(['logs:putlogevents', 'logs:getlogevents', 'logs:createlogstream', 'logs:deletelogstream']);
/** An opaque stand-in for what a template does not resolve. It holds no colon, so it never forges an ARN segment. */
const TOKEN = '{token}';
/** The cap on the alternatives one value renders to (`Fn::If` multiplies them). */
const MAX_RENDERINGS = 64;

type Resource = { Type?: string; Properties?: Record<string, unknown> };
type Template = { Resources?: Record<string, Resource>; Outputs?: Record<string, { Value?: unknown; Export?: { Name?: unknown } }> };
type Templates = Record<string, Template>;
type Statement = { Effect?: unknown; Action?: unknown; NotAction?: unknown; Resource?: unknown };

export interface Offender { stack: string; logicalId: string; action: string; resource: string }

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Every exported value in the app, by export name, with the stack whose template resolves it. */
function exportsOf(templates: Templates): Map<string, { stack: string; value: unknown }> {
  const out = new Map<string, { stack: string; value: unknown }>();
  for (const [stack, t] of Object.entries(templates)) {
    for (const o of Object.values(t.Outputs ?? {})) {
      if (typeof o?.Export?.Name === 'string') out.set(o.Export.Name, { stack, value: o.Value });
    }
  }
  return out;
}

/** Each string a CloudFormation value can render to, with what cannot be resolved kept as `TOKEN`. */
function render(v: unknown, stack: string, templates: Templates, exports: Map<string, { stack: string; value: unknown }>, depth = 0): string[] {
  if (typeof v === 'string') return [v];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  if (depth > 8 || typeof v !== 'object' || v === null || Array.isArray(v)) return [TOKEN];
  const at = (x: unknown, s = stack): string[] => render(x, s, templates, exports, depth + 1);
  const o = v as Record<string, unknown>;

  if ('Fn::Join' in o) {
    const [sep, parts] = o['Fn::Join'] as [string, unknown];
    if (!Array.isArray(parts)) return [TOKEN];
    let acc = [''];
    parts.forEach((p, i) => {
      const next: string[] = [];
      for (const a of acc) for (const b of at(p)) next.push(i === 0 ? b : `${a}${sep}${b}`);
      acc = next.slice(0, MAX_RENDERINGS);
    });
    return acc;
  }
  if ('Fn::Sub' in o) {
    const arg = o['Fn::Sub'];
    const [body, vars] = Array.isArray(arg) ? (arg as [string, Record<string, unknown>]) : [arg as string, {}];
    if (typeof body !== 'string') return [TOKEN];
    let acc = [''];
    let last = 0;
    const pushLiteral = (s: string) => { acc = acc.map((a) => a + s); };
    for (const m of body.matchAll(/\$\{([^}]*)\}/g)) {
      pushLiteral(body.slice(last, m.index));
      last = (m.index ?? 0) + m[0].length;
      const name = m[1];
      if (name.startsWith('!')) { pushLiteral(`\${${name.slice(1)}}`); continue; }
      const alts = vars && name in vars ? at(vars[name]) : [TOKEN];
      acc = acc.flatMap((a) => alts.map((b) => a + b)).slice(0, MAX_RENDERINGS);
    }
    pushLiteral(body.slice(last));
    return acc;
  }
  if ('Fn::GetAtt' in o) {
    const arg = o['Fn::GetAtt'];
    const [id, attr] = typeof arg === 'string' ? arg.split('.') : (arg as [string, string]);
    // A log group's `Arn` attribute is `arn:<partition>:logs:<region>:<account>:log-group:<name>:*`.
    if (attr === 'Arn' && templates[stack]?.Resources?.[id]?.Type === 'AWS::Logs::LogGroup') {
      return [`arn:${TOKEN}:logs:${TOKEN}:${TOKEN}:log-group:${TOKEN}:*`];
    }
    return [TOKEN];
  }
  if ('Fn::ImportValue' in o) {
    const names = at(o['Fn::ImportValue']);
    const out = names.flatMap((n) => {
      const e = exports.get(n);
      return e ? render(e.value, e.stack, templates, exports, depth + 1) : [TOKEN];
    });
    return out.slice(0, MAX_RENDERINGS);
  }
  if ('Fn::If' in o) {
    const [, a, b] = o['Fn::If'] as [unknown, unknown, unknown];
    return [...at(a), ...at(b)].slice(0, MAX_RENDERINGS);
  }
  return [TOKEN];
}

/** The rendered resources a statement names; an `Fn::If` around the whole list contributes both branches. */
function resourcesOf(s: Statement, stack: string, templates: Templates, exports: Map<string, { stack: string; value: unknown }>): string[] {
  const flat = (r: unknown): unknown[] => {
    if (r && typeof r === 'object' && !Array.isArray(r) && 'Fn::If' in r) {
      const [, a, b] = (r as { 'Fn::If': [unknown, unknown, unknown] })['Fn::If'];
      return [...flat(a), ...flat(b)];
    }
    return Array.isArray(r) ? r.flatMap(flat) : r === undefined ? [] : [r];
  };
  return flat(s.Resource).flatMap((r) => render(r, stack, templates, exports));
}

/** True when an ARN is in Log Stream form: anything after the log group name, or a `log-stream` segment. */
export function isLogStreamArn(arn: string): boolean {
  return /:log-group:[^:]*:/.test(arn) || /:log-stream:/.test(arn);
}

/** The actions an Allow statement grants that a Log Stream ARN stops granting. */
export function groupActionsOf(s: Statement): string[] {
  if (s.Effect !== 'Allow') return [];
  if (s.NotAction !== undefined) {
    // An Allow with NotAction grants every action it does not exclude, the log group actions with them.
    const excluded = list(s.NotAction).map((a) => String(a).toLowerCase());
    return excluded.includes('*') || excluded.includes('logs:*') ? [] : [`NotAction:${JSON.stringify(s.NotAction)}`];
  }
  return list(s.Action)
    .filter((a): a is string => typeof a === 'string')
    .filter((a) => {
      const l = a.toLowerCase();
      return (l === '*' || l.startsWith('logs:')) && !STREAM_ACTIONS.has(l);
    });
}

/** Every policy document a resource holds: an object with `Statement`, or a JSON policy string. */
function documentsIn(v: unknown, stack: string, templates: Templates, exports: Map<string, { stack: string; value: unknown }>, out: Statement[][], depth = 0): void {
  if (depth > 12 || v === null || v === undefined) return;
  if (typeof v === 'string') {
    if (!v.includes('"Statement"')) return;
    try { documentsIn(JSON.parse(v), stack, templates, exports, out, depth + 1); } catch { /* not a policy */ }
    return;
  }
  if (typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) documentsIn(x, stack, templates, exports, out, depth + 1); return; }
  const o = v as Record<string, unknown>;
  if ('Statement' in o) { out.push(list(o.Statement) as Statement[]); return; }
  // A policy string assembled from tokens (an `Fn::Join` or `Fn::Sub` of JSON text) is read as rendered.
  if ('Fn::Join' in o || 'Fn::Sub' in o) {
    for (const s of render(o, stack, templates, exports)) if (s.includes('"Statement"')) documentsIn(s, stack, templates, exports, out, depth + 1);
    return;
  }
  for (const x of Object.values(o)) documentsIn(x, stack, templates, exports, out, depth + 1);
}

/** Every statement in every policy of every stack, with where it lives and what its resources render to. */
export function statementsOf(templates: Templates): Array<{ stack: string; logicalId: string; s: Statement; resources: string[] }> {
  const exports = exportsOf(templates);
  const out: Array<{ stack: string; logicalId: string; s: Statement; resources: string[] }> = [];
  for (const [stack, t] of Object.entries(templates)) {
    for (const [logicalId, r] of Object.entries(t.Resources ?? {})) {
      const docs: Statement[][] = [];
      documentsIn(r.Properties, stack, templates, exports, docs);
      for (const doc of docs) for (const s of doc) out.push({ stack, logicalId, s, resources: resourcesOf(s, stack, templates, exports) });
    }
  }
  return out;
}

/** Every Allow of a log group action on a Log Stream ARN, one per (statement, action, resource). */
export function logStreamGroupGrants(templates: Templates): Offender[] {
  const out: Offender[] = [];
  for (const { stack, logicalId, s, resources } of statementsOf(templates)) {
    const actions = groupActionsOf(s);
    if (!actions.length) continue;
    for (const resource of resources.filter(isLogStreamArn)) for (const action of actions) out.push({ stack, logicalId, action, resource });
  }
  return out;
}

const describeOffender = (o: Offender): string => `${o.stack} ${o.logicalId}: ${o.action} on ${o.resource}`;

describe.each(SYNTH_VARIANTS.map((v) => [v.id, v] as const))('a log group action names a log group ARN (%s)', (_id, variant) => {
  let templates: Templates;
  beforeAll(() => {
    templates = synthesizeApp(REPO_ROOT, { id: `logs-arn-${variant.id}`, context: variant.context }).templates as Templates;
  }, SYNTH_TIMEOUT_MS);

  it('reads the policies the app holds, logs grants and stream-form resources among them (the check is not vacuous)', () => {
    const all = statementsOf(templates);
    expect(all.length).toBeGreaterThan(100);
    // The Lambda boundary grants logs actions, so the action reading meets real logs grants.
    expect(all.some(({ s }) => list(s.Action).some((a) => String(a).startsWith('logs:')))).toBe(true);
    // A log group's write grant names its `Arn` attribute, so the rendering meets real stream-form resources.
    expect(all.some(({ resources }) => resources.some(isLogStreamArn))).toBe(true);
  });

  it('grants no log group action on a Log Stream ARN', () => {
    expect(logStreamGroupGrants(templates).map(describeOffender)).toEqual([]);
  });
});

describe('the log stream check refuses the shapes it names', () => {
  const role = (statements: unknown[]): Resource => ({
    Type: 'AWS::IAM::Role',
    Properties: { Policies: [{ PolicyName: 'p', PolicyDocument: { Version: '2012-10-17', Statement: statements } }] },
  });

  it('flags a log group action on each stream form, through every rendering, and names where it is', () => {
    const templates: Templates = {
      Exporter: {
        Resources: { Group: { Type: 'AWS::Logs::LogGroup' } },
        Outputs: { GroupArn: { Value: { 'Fn::GetAtt': ['Group', 'Arn'] }, Export: { Name: 'Exporter:GroupArn' } } },
      },
      Fixture: {
        Resources: {
          Group: { Type: 'AWS::Logs::LogGroup' },
          Literal: role([{ Effect: 'Allow', Action: 'logs:DescribeLogGroups', Resource: 'arn:aws:logs:us-east-1:123456789012:log-group:/x:*' }]),
          Joined: role([{ Effect: 'Allow', Action: 'logs:*', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':logs:us-east-1:123456789012:log-group:', { Ref: 'Name' }, ':*']] } }]),
          Subbed: role([{ Effect: 'Allow', Action: '*', Resource: { 'Fn::Sub': 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:${Name}:log-stream:*' } }]),
          Attribute: role([{ Effect: 'Allow', Action: ['logs:PutLogEvents', 'logs:PutRetentionPolicy'], Resource: { 'Fn::GetAtt': ['Group', 'Arn'] } }]),
          Imported: role([{ Effect: 'Allow', Action: 'logs:Put*', Resource: { 'Fn::ImportValue': 'Exporter:GroupArn' } }]),
          Boundary: { Type: 'AWS::IAM::ManagedPolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', NotAction: 's3:*', Resource: 'arn:aws:logs:r:a:log-group:g:*' }] } } },
          ResourcePolicy: { Type: 'AWS::Logs::ResourcePolicy', Properties: { PolicyDocument: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 'logs:TagResource', Resource: 'arn:aws:logs:r:a:log-group:g:log-stream:s' }] }) } },
        },
      },
    };
    expect(logStreamGroupGrants(templates).map(describeOffender)).toEqual([
      'Fixture Literal: logs:DescribeLogGroups on arn:aws:logs:us-east-1:123456789012:log-group:/x:*',
      `Fixture Joined: logs:* on arn:${TOKEN}:logs:us-east-1:123456789012:log-group:${TOKEN}:*`,
      `Fixture Subbed: * on arn:${TOKEN}:logs:${TOKEN}:${TOKEN}:log-group:${TOKEN}:log-stream:*`,
      `Fixture Attribute: logs:PutRetentionPolicy on arn:${TOKEN}:logs:${TOKEN}:${TOKEN}:log-group:${TOKEN}:*`,
      `Fixture Imported: logs:Put* on arn:${TOKEN}:logs:${TOKEN}:${TOKEN}:log-group:${TOKEN}:*`,
      'Fixture Boundary: NotAction:"s3:*" on arn:aws:logs:r:a:log-group:g:*',
      'Fixture ResourcePolicy: logs:TagResource on arn:aws:logs:r:a:log-group:g:log-stream:s',
    ]);
  });

  it('passes the four stream actions on a stream ARN, a log group action on a log group ARN or "*", and a Deny', () => {
    const templates: Templates = {
      Fixture: {
        Resources: {
          Group: { Type: 'AWS::Logs::LogGroup' },
          Write: role([{ Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:GetLogEvents', 'logs:DeleteLogStream'], Resource: { 'Fn::GetAtt': ['Group', 'Arn'] } }]),
          GroupForm: role([{ Effect: 'Allow', Action: 'logs:PutRetentionPolicy', Resource: ['arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/*', 'arn:aws:logs:us-east-1:123456789012:log-group:*'] }]),
          Everything: role([{ Effect: 'Allow', Action: 'logs:*', Resource: '*' }]),
          Denied: role([{ Effect: 'Deny', Action: 'logs:*', Resource: 'arn:aws:logs:r:a:log-group:g:*' }]),
          NotLogs: role([{ Effect: 'Allow', NotAction: 'logs:*', Resource: 'arn:aws:logs:r:a:log-group:g:*' }]),
        },
      },
    };
    expect(logStreamGroupGrants(templates).map(describeOffender)).toEqual([]);
  });
});
