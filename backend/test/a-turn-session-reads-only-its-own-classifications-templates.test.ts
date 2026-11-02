/**
 * A TURN'S SESSION READS ITS OWN CLASSIFICATION'S TEMPLATES, AND NO OTHER'S (ADR-062 decision 2; tenets D4, D13, D15).
 *
 * A turn runs on a vended session, and the session's permission is three layers at once: the acting role's identity
 * policies, its permissions boundary, and the session policies the vend passes (`assistantGrantCatalog`, one per
 * edge, `base` on every turn). A grant missing from any one layer is a refusal at runtime that no single-layer
 * assertion sees: the role and the boundary both admitted the template listing while the `base` session edge held
 * none, so every stored message template was passed over for the shipped one inside a real turn.
 *
 * So this evaluates the synthesized layers together, the way IAM does for a session: a request is allowed when every
 * layer allows it and no layer denies it. The requests are the ones the template store makes (`template-store.ts`):
 * a listing of a family's prefix, a body read by its content-addressed key, and a pointer read. Conditions other than
 * `s3:prefix` are taken to hold, which can only make a layer allow more, so a refusal here is a refusal in AWS.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS, TEST_ENV } from './helpers/synth';
import { templateKey, templatePointerName, templateFamilyPrefix } from '../lambda/src/lib/template-store';
import { SSM_ROOT } from '../lib/stacks/agent-classification-common';

type Resource = { Type: string; Properties?: Record<string, any> };
type Statement = {
  Effect: 'Allow' | 'Deny';
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: Record<string, Record<string, string | string[]>>;
};
interface Request { action: string; resource: string; prefix?: string }

const OWN = 'premium';
const OTHER = 'standard';
const BUCKET = CLASSIFICATION_TEST_PROPS.attachmentsBucketArn;
const HASH = 'a'.repeat(64);

function synth(classification: string): Record<string, Resource> {
  const app = new cdk.App({ context: {} });
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
}

const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : resolveJoin(x)));
/** A synthesized `Fn::Join` of literals, as a string; any other token is left as one that matches nothing. */
function resolveJoin(x: unknown): string {
  const join = (x as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
  if (!join) return `<token ${JSON.stringify(x)}>`;
  return join[1].map((p) => (typeof p === 'string' ? p : p && (p as any).Ref === 'AWS::Partition' ? 'aws' : resolveJoin(p))).join(join[0]);
}
const glob = (pattern: string, value: string) =>
  new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);

function matches(s: Statement, r: Request): boolean {
  const actionHit = (a: string) => glob(a, r.action);
  if (s.Action !== undefined && !list(s.Action).some(actionHit)) return false;
  if (s.NotAction !== undefined && list(s.NotAction).some(actionHit)) return false;
  if (s.Resource !== undefined && !list(s.Resource).some((p) => glob(p, r.resource))) return false;
  if (s.NotResource !== undefined && list(s.NotResource).some((p) => glob(p, r.resource))) return false;
  for (const [op, kv] of Object.entries(s.Condition ?? {})) {
    for (const [key, want] of Object.entries(kv)) {
      if (key !== 's3:prefix') continue;
      if (op !== 'StringLike' && op !== 'StringEquals') continue;
      if (r.prefix === undefined || !list(want).some((w) => glob(w, r.prefix!))) return false;
    }
  }
  return true;
}

/** One layer's verdict: an explicit Deny wins, then any Allow. */
function layerAllows(statements: Statement[], r: Request): boolean {
  if (statements.some((s) => s.Effect === 'Deny' && matches(s, r))) return false;
  return statements.some((s) => s.Effect === 'Allow' && matches(s, r));
}

/** The three layers of a turn's session, read from a synthesized classification. */
function sessionLayers(resources: Record<string, Resource>): { role: Statement[]; boundary: Statement[]; base: Statement[]; edges: Record<string, Statement[]> } {
  const [roleId, role] = Object.entries(resources).find(([id, r]) => r.Type === 'AWS::IAM::Role' && /AssistantActingRole/.test(id))!;
  const refersToRole = (r: Resource) => JSON.stringify(r.Properties?.Roles ?? []).includes(`"${roleId}"`);
  const roleStatements: Statement[] = [];
  for (const p of role.Properties?.Policies ?? []) roleStatements.push(...p.PolicyDocument.Statement);
  for (const r of Object.values(resources)) {
    if ((r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') && refersToRole(r)) roleStatements.push(...r.Properties!.PolicyDocument.Statement);
  }
  const boundaryRef = role.Properties!.PermissionsBoundary?.Ref as string;
  const boundary: Statement[] = resources[boundaryRef].Properties!.PolicyDocument.Statement;
  const edges: Record<string, Statement[]> = {};
  for (const r of Object.values(resources)) {
    const name = String(r.Properties?.ManagedPolicyName ?? '');
    const m = /AssistantGrant-[^-]+-(.+)$/.exec(name);
    if (r.Type === 'AWS::IAM::ManagedPolicy' && m) edges[m[1]] = r.Properties!.PolicyDocument.Statement;
  }
  return { role: roleStatements, boundary, base: edges.base, edges };
}

/** Whether a turn's session allows a request, narrowed to `base` plus the given edges. */
function sessionAllows(resources: Record<string, Resource>, r: Request, extraEdges: string[] = []): boolean {
  const l = sessionLayers(resources);
  const sessionPolicies = [l.base, ...extraEdges.map((e) => l.edges[e] ?? [])].flat();
  return layerAllows(l.role, r) && layerAllows(l.boundary, r) && layerAllows(sessionPolicies, r);
}

const ASSISTANT = { family: 'assistant' as const, assistant: 'advisor' };
const listing = (classification: string, owner?: typeof ASSISTANT): Request =>
  ({ action: 's3:ListBucket', resource: BUCKET, prefix: templateFamilyPrefix(classification, owner) });
const body = (classification: string, owner?: typeof ASSISTANT): Request =>
  ({ action: 's3:GetObject', resource: `${BUCKET}/${templateKey(classification, 'welcome', HASH, owner)}` });
const pointer = (classification: string, owner?: typeof ASSISTANT): Request =>
  ({ action: 'ssm:GetParameter', resource: `arn:aws:ssm:${TEST_ENV.region}:${TEST_ENV.account}:parameter${templatePointerName(SSM_ROOT, classification, 'welcome', owner)}` });

let own: Record<string, Resource>;
beforeAll(() => {
  own = synth(OWN);
});

describe(`a ${OWN} turn's session, narrowed to the base edge alone`, () => {
  it('holds a base edge and an acting role with a boundary (the layers the evaluation reads)', () => {
    const l = sessionLayers(own);
    expect(l.base.length).toBeGreaterThan(0);
    expect(l.role.length).toBeGreaterThan(0);
    expect(l.boundary.length).toBeGreaterThan(0);
  });

  it.each([
    ['the classification family', undefined],
    ["an assistant's own family", ASSISTANT],
  ])('lists, reads a body of, and reads a pointer of %s', (_label, owner) => {
    expect(sessionAllows(own, listing(OWN, owner))).toBe(true);
    expect(sessionAllows(own, body(OWN, owner))).toBe(true);
    expect(sessionAllows(own, pointer(OWN, owner))).toBe(true);
  });

  it('the base edge alone lists no prefix but the templates (context and platform knowledge stay narrowed to their edges)', () => {
    expect(sessionAllows(own, { action: 's3:ListBucket', resource: BUCKET, prefix: 'context/' })).toBe(false);
    expect(sessionAllows(own, { action: 's3:ListBucket', resource: BUCKET, prefix: 'platform-knowledge/premium/' })).toBe(false);
    expect(sessionAllows(own, { action: 's3:ListBucket', resource: BUCKET, prefix: 'templates/' })).toBe(false);
  });
});

describe(`REFUSED: a ${OWN} turn's session reads no ${OTHER} template, whatever edges it holds`, () => {
  const everyEdge = () => Object.keys(sessionLayers(own).edges);

  it.each([
    ['the classification family', undefined],
    ["an assistant's own family", ASSISTANT],
  ])(`lists, reads a body of, or reads a pointer of ${OTHER}'s %s: refused`, (_label, owner) => {
    expect(sessionAllows(own, listing(OTHER, owner), everyEdge())).toBe(false);
    expect(sessionAllows(own, body(OTHER, owner), everyEdge())).toBe(false);
    expect(sessionAllows(own, pointer(OTHER, owner), everyEdge())).toBe(false);
  });

  it('writes no template of its own either', () => {
    expect(sessionAllows(own, { action: 's3:PutObject', resource: body(OWN).resource }, everyEdge())).toBe(false);
    expect(sessionAllows(own, { action: 'ssm:PutParameter', resource: pointer(OWN).resource }, everyEdge())).toBe(false);
  });
});
