/**
 * A SHARED GRANT NAMES NO LIST OF CLASSIFICATIONS (the classification-independence plan, step 1).
 *
 * A role that serves every conversation (the channel flow, post-processing, battle, the share, the admin plane)
 * reaches every classification by the resource carrying a `classification` tag (`Null` false), never by a list
 * of the declared values, and every SSM read it makes across classifications is a path wildcard. A list there
 * changes whenever a classification is declared or removed, so the shared stack would have to be redeployed
 * with it, which is the coupling a classification deployed on its own must not have.
 *
 * A role of ONE classification still names its own value, and its grant set (`grantsFor`) where it acts for a
 * person, and it is built in its classification's own `Assistants-<classification>` stack (tenet D12, ADR-042),
 * so no shared stack holds one: a person's vend role, a conversation creator and the runtime assistants' build
 * session (written as the session's own `classification` tag) are each their classification's or name none.
 *
 * Read from the synthesized app with every built capability declared, in the shipped catalog, where the
 * declared set has more than one value to list.
 */
import * as path from 'path';
import { SYNTH_CAPABILITIES, synthesizeApp, type SynthesizedApp } from '../lib/docs/api-contract';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;
const KEYS = ['aws:ResourceTag/classification', 'aws:RequestTag/classification'];

type Statement = { Effect?: string; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Every policy statement in the app's shared stacks, with the stack and the logical id it is on. */
function sharedStatements(app: SynthesizedApp): Array<{ stack: string; id: string; s: Statement }> {
  const out: Array<{ stack: string; id: string; s: Statement }> = [];
  for (const [stack, t] of Object.entries(app.templates)) {
    if (/Assistants-[^/]+$/.test(stack)) continue;
    for (const [id, r] of Object.entries(((t as { Resources?: Record<string, any> }).Resources ?? {}))) {
      const p = r.Properties ?? {};
      const docs = r.Type === 'AWS::IAM::Role' ? list(p.Policies).map((x: any) => x.PolicyDocument)
        : r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy' ? [p.PolicyDocument] : [];
      for (const d of docs) for (const s of list((d as any)?.Statement) as Statement[]) out.push({ stack, id, s });
    }
  }
  return out;
}

/** The classification values a statement's condition permits, by a positive operator, more than one of them. */
export function listedClassifications(s: Statement): string[] {
  const out = new Set<string>();
  for (const [op, keys] of Object.entries(s.Condition ?? {})) {
    if (op === 'Null' || op.startsWith('StringNot') || op.startsWith('ForAllValues:StringNot')) continue;
    for (const k of KEYS) for (const v of list((keys as Record<string, unknown>)?.[k])) out.add(String(v));
  }
  return out.size > 1 ? [...out] : [];
}

/** A resource as a plain string, so a per-classification SSM path in a `Fn::Join` is still read. */
function rendered(r: unknown): string {
  if (typeof r === 'string') return r;
  const join = (r as any)?.['Fn::Join'];
  if (join) return (join[1] as unknown[]).map((p) => (typeof p === 'string' ? p : '${token}')).join(join[0]);
  return JSON.stringify(r);
}

/**
 * The classifications a statement names per-classification SSM keys of (an assignment path, a router, task
 * service, vend or processor key), when it names more than one: a list written as resources. A role of one
 * classification reading its own keys names one.
 */
export function perClassificationParameters(s: Statement, declared: readonly string[]): string[] {
  const named = new Set<string>();
  for (const r of list(s.Resource).map(rendered)) {
    for (const c of declared) {
      if (r.includes(`/assistant-assignments/${c}`) || new RegExp(`/assistant/${c}/(router-arn|task-service-arn|vend-arn|processor-arn)$`).test(r)) named.add(c);
    }
  }
  return named.size > 1 ? [...named] : [];
}

describe('a shared grant names no list of classifications', () => {
  let app: SynthesizedApp;
  const declared = profiles.classificationValues();
  beforeAll(() => {
    app = synthesizeApp(REPO_ROOT, { id: 'athena+capabilities', context: { analyticsMode: 'athena', capabilities: [...SYNTH_CAPABILITIES] } });
  }, SYNTH_TIMEOUT_MS);

  it('reads a declared set with more than one value, so a list could be written (the check is not vacuous)', () => {
    expect(declared.length).toBeGreaterThan(1);
    expect(sharedStatements(app).length).toBeGreaterThan(100);
    // A shared reach is written, and written as the tag being present.
    expect(sharedStatements(app).some(({ s }) => KEYS.some((k) => s.Condition?.Null?.[k] === 'false'))).toBe(true);
  });

  it('no statement in a shared stack permits a list of classification values', () => {
    const listed = sharedStatements(app)
      .filter(({ s }) => listedClassifications(s).length)
      .map(({ stack, id, s }) => `${stack}/${id}: ${listedClassifications(s).join(',')}`);
    expect(listed).toEqual([]);
  });

  it('no statement in a shared stack names several classifications\' assignment, router, task service or vend keys', () => {
    const named = sharedStatements(app)
      .filter(({ s }) => perClassificationParameters(s, declared).length)
      .map(({ stack, id, s }) => `${stack}/${id}: ${perClassificationParameters(s, declared).join(',')}`);
    expect(named).toEqual([]);
  });
});

describe('the list check refuses the shapes it names', () => {
  it('reads a positive list on either tag key, and passes a Null test, a single value and a negated list', () => {
    expect(listedClassifications({ Condition: { StringEquals: { 'aws:ResourceTag/classification': ['a', 'b'] } } })).toEqual(['a', 'b']);
    expect(listedClassifications({ Condition: { StringEquals: { 'aws:RequestTag/classification': ['a', 'b'] } } })).toEqual(['a', 'b']);
    expect(listedClassifications({ Condition: { Null: { 'aws:ResourceTag/classification': 'false' } } })).toEqual([]);
    expect(listedClassifications({ Condition: { StringEquals: { 'aws:ResourceTag/classification': 'a' } } })).toEqual([]);
    expect(listedClassifications({ Condition: { StringNotEquals: { 'aws:ResourceTag/classification': ['admin', 'x'] } } })).toEqual([]);
  });

  it('names the keys of several classifications, and passes one classification\'s own keys and the path wildcard', () => {
    const declared = ['legal', 'finance'];
    expect(perClassificationParameters({
      Resource: ['arn:aws:ssm:r:a:parameter/ae/assistant-assignments/legal/*', 'arn:aws:ssm:r:a:parameter/ae/assistant/finance/router-arn'],
    }, declared)).toEqual(['legal', 'finance']);
    expect(perClassificationParameters({
      Resource: ['arn:aws:ssm:r:a:parameter/ae/assistant-assignments/legal', 'arn:aws:ssm:r:a:parameter/ae/assistant-assignments/legal/*'],
    }, declared)).toEqual([]);
    expect(perClassificationParameters({ Resource: ['arn:aws:ssm:r:a:parameter/ae/assistant-assignments/*', 'arn:aws:ssm:r:a:parameter/ae/assistant/*/router-arn'] }, declared)).toEqual([]);
  });
});
