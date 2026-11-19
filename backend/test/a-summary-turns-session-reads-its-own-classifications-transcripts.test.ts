/**
 * A TURN'S SESSION LISTS AND READS ITS OWN CLASSIFICATION'S MEETING TRANSCRIPTS, AND NO OTHER'S (SPEC-ASSISTANT-MEETINGS
 * FR28, FR66; tenets D4, D15).
 *
 * A recorded meeting's summary turn lists the meeting's segments under `transcripts/<classification>/`, and a turn
 * grounded on a room's child lists that conversation's transcripts to find the newest. Both run on the vended session,
 * whose permission is the acting role, its boundary and the session policies (`assistantGrantCatalog`, `base` on every
 * turn) together. This evaluates the synthesized layers together, the way IAM does for a session, so a listing missing
 * from any one layer is a refusal here.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { segmentsPrefix, conversationTranscriptsPrefix, transcriptKey } from '../lambda/src/lib/meeting-transcript';

type Resource = { Type: string; Properties?: Record<string, any> };
type Statement = {
  Effect: 'Allow' | 'Deny'; Action?: string | string[]; NotAction?: string | string[]; Resource?: unknown; NotResource?: unknown;
  Condition?: Record<string, Record<string, string | string[]>>;
};
interface Request { action: string; resource: string; prefix?: string }

const OWN = 'premium';
const OTHER = 'standard';
const BUCKET = CLASSIFICATION_TEST_PROPS.attachmentsBucketArn;
const M = 'a1b2c3d4-0000-1111-2222-333344445555';

const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : resolveJoin(x)));
function resolveJoin(x: unknown): string {
  const join = (x as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
  if (!join) return `<token ${JSON.stringify(x)}>`;
  return join[1].map((p) => (typeof p === 'string' ? p : p && (p as any).Ref === 'AWS::Partition' ? 'aws' : resolveJoin(p))).join(join[0]);
}
const glob = (pattern: string, value: string) =>
  new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);

function matches(s: Statement, r: Request): boolean {
  const hit = (a: string) => glob(a, r.action);
  if (s.Action !== undefined && !list(s.Action).some(hit)) return false;
  if (s.NotAction !== undefined && list(s.NotAction).some(hit)) return false;
  if (s.Resource !== undefined && !list(s.Resource).some((p) => glob(p, r.resource))) return false;
  if (s.NotResource !== undefined && list(s.NotResource).some((p) => glob(p, r.resource))) return false;
  for (const [op, kv] of Object.entries(s.Condition ?? {})) {
    for (const [key, want] of Object.entries(kv)) {
      if (key !== 's3:prefix' || (op !== 'StringLike' && op !== 'StringEquals')) continue;
      if (r.prefix === undefined || !list(want).some((w) => glob(w, r.prefix!))) return false;
    }
  }
  return true;
}
const layerAllows = (statements: Statement[], r: Request) =>
  !statements.some((s) => s.Effect === 'Deny' && matches(s, r)) && statements.some((s) => s.Effect === 'Allow' && matches(s, r));

function layers(resources: Record<string, Resource>) {
  const [roleId, role] = Object.entries(resources).find(([id, r]) => r.Type === 'AWS::IAM::Role' && /AssistantActingRole/.test(id))!;
  const refersToRole = (r: Resource) => JSON.stringify(r.Properties?.Roles ?? []).includes(`"${roleId}"`);
  const roleStatements: Statement[] = [];
  for (const p of role.Properties?.Policies ?? []) roleStatements.push(...p.PolicyDocument.Statement);
  for (const r of Object.values(resources)) {
    if ((r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') && refersToRole(r)) roleStatements.push(...r.Properties!.PolicyDocument.Statement);
  }
  const boundary: Statement[] = resources[role.Properties!.PermissionsBoundary?.Ref as string].Properties!.PolicyDocument.Statement;
  const edges: Record<string, Statement[]> = {};
  for (const r of Object.values(resources)) {
    const m = /AssistantGrant-[^-]+-(.+)$/.exec(String(r.Properties?.ManagedPolicyName ?? ''));
    if (r.Type === 'AWS::IAM::ManagedPolicy' && m) edges[m[1]] = r.Properties!.PolicyDocument.Statement;
  }
  return { role: roleStatements, boundary, edges };
}

let resources: Record<string, Resource>;
beforeAll(() => {
  const app = new cdk.App({ context: {} });
  const stack = assistantsOf(OWN)(app, `AgentEchelonAssistants-${OWN}`, { ...CLASSIFICATION_TEST_PROPS, capabilities: ['meetings'] } as never);
  resources = (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
});

/** Whether a turn's session, narrowed to `base` (every turn's edge) plus the given edges, allows a request. */
function sessionAllows(r: Request, extra: string[] = []): boolean {
  const l = layers(resources);
  return layerAllows(l.role, r) && layerAllows(l.boundary, r) && layerAllows([l.edges.base, ...extra.map((e) => l.edges[e] ?? [])].flat(), r);
}

describe(`a ${OWN} turn's session on the base edge alone`, () => {
  it("lists a meeting's segments and a conversation's transcripts in its own classification's family", () => {
    expect(sessionAllows({ action: 's3:ListBucket', resource: BUCKET, prefix: segmentsPrefix(OWN, 'meet-1', M) })).toBe(true);
    expect(sessionAllows({ action: 's3:ListBucket', resource: BUCKET, prefix: conversationTranscriptsPrefix(OWN, 'meet-1') })).toBe(true);
  });

  it('reads a segment and a transcript there', () => {
    expect(sessionAllows({ action: 's3:GetObject', resource: `${BUCKET}/${segmentsPrefix(OWN, 'meet-1', M)}0000000001000-r1.json` })).toBe(true);
    expect(sessionAllows({ action: 's3:GetObject', resource: `${BUCKET}/${transcriptKey(OWN, 'meet-1', M)}` })).toBe(true);
  });
});

describe(`REFUSED: a ${OWN} turn's session reaches no ${OTHER} transcript, whatever edges it holds`, () => {
  const every = () => Object.keys(layers(resources).edges);
  it('lists and reads nothing of another classification, or of the whole family', () => {
    expect(sessionAllows({ action: 's3:ListBucket', resource: BUCKET, prefix: segmentsPrefix(OTHER, 'meet-1', M) }, every())).toBe(false);
    expect(sessionAllows({ action: 's3:ListBucket', resource: BUCKET, prefix: 'transcripts/' }, every())).toBe(false);
    expect(sessionAllows({ action: 's3:GetObject', resource: `${BUCKET}/${transcriptKey(OTHER, 'meet-1', M)}` }, every())).toBe(false);
  });

  it('writes no transcript of its own', () => {
    expect(sessionAllows({ action: 's3:PutObject', resource: `${BUCKET}/${transcriptKey(OWN, 'meet-1', M)}` }, every())).toBe(false);
  });
});
