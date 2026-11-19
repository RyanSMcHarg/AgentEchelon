/**
 * A TEAM WRITER REACHES ONLY THE ASSISTANT ITS SESSION IS TAGGED WITH (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT 5.1,
 * tenets D3 and D12).
 *
 * Each function that serves a team's routes writes on a team writer role while it serves one
 * (`lib/constructs/team-writer-role.ts`): `manage-profiles`, the message templates and the experiments. Read from the
 * SYNTHESIZED template and evaluated the way IAM evaluates it, for the operators these policies use (an operator this
 * evaluator does not read fails the test rather than passing it):
 *
 *   - THE TRUST: the function's own execution role alone may assume it, on the assume and on the tagging, and only with
 *     an `assistant` tag that is present and one path segment, and no other tag key (`alt` on the profile writer alone);
 *   - THE GRANTS: a session tagged `advisor` writes advisor's versions, draft, advertisement, bodies, golden-set
 *     hand-overs, template family and experiments, and is refused every one of them for `ops-premium`; an experiment row
 *     is written only under `advisor.<id>`, never another assistant's or an id without the prefix; the deploy's keys and
 *     the template pointers stay refused; an alt's candidate is written only on a session tagged with that alt;
 *   - THE BOUNDARY: each role carries a permissions boundary of its own statements;
 *   - THE WIRING: each execution role may assume its own team writer and no other, and its function is told the role.
 *
 * The handler half, that a team route's writes go out on that session tagged with the PATH's assistant even when the
 * handler's own check names another, is `lib/a-team-route-writes-on-its-team-writer-session.test.ts`.
 */
import { assistantAdministrationTemplate } from './helpers/synth';
import { SSM_ROOT } from '../lib/stacks/agent-classification-common';

type Resource = { Type: string; Properties?: Record<string, any> };
interface Stmt { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> }

const resources: Record<string, Resource> = (assistantAdministrationTemplate({}).toJSON() as { Resources: Record<string, Resource> }).Resources;
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** A CloudFormation value as text: a reference becomes a placeholder naming it, so two renders of one value agree. */
function render(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = v as Record<string, any>;
  if (o?.Ref) return `{Ref:${o.Ref}}`;
  if (o?.['Fn::GetAtt']) return `{GetAtt:${list(o['Fn::GetAtt']).join('.')}}`;
  if (o?.['Fn::Join']) return (o['Fn::Join'][1] as unknown[]).map(render).join(o['Fn::Join'][0]);
  return JSON.stringify(v);
}

const idOf = (prefix: string, type: string): string => {
  const ids = Object.keys(resources).filter((id) => id.startsWith(prefix) && resources[id].Type === type);
  if (ids.length !== 1) throw new Error(`expected one ${type} named ${prefix}*, found ${ids.join(', ') || 'none'}`);
  return ids[0];
};

/** Every identity statement a role carries: inline, by a policy resource naming it, and by an attached managed policy. */
function statementsOf(roleId: string): Stmt[] {
  const role = resources[roleId];
  const inline = list(role.Properties?.Policies).flatMap((p: any) => list(p.PolicyDocument.Statement)) as Stmt[];
  const attached = Object.values(resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties?.Roles ?? []).includes(`"${roleId}"`))
    .flatMap((r) => list(r.Properties!.PolicyDocument.Statement)) as Stmt[];
  const managed = list(role.Properties?.ManagedPolicyArns)
    .map((a: any) => a?.Ref && resources[a.Ref])
    .filter((r): r is Resource => !!r && r.Type === 'AWS::IAM::ManagedPolicy')
    .flatMap((r) => list(r.Properties!.PolicyDocument.Statement)) as Stmt[];
  return [...inline, ...attached, ...managed];
}

const glob = (pattern: string, value: string): boolean =>
  new RegExp(`^${pattern.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`).test(value);

/** Substitute `${aws:PrincipalTag/<k>}`; undefined when a tag it names is absent, so the element matches nothing. */
function substitute(text: string, tags: Record<string, string>): string | undefined {
  let missing = false;
  const out = text.replace(/\$\{aws:PrincipalTag\/([^}]+)\}/g, (_m, k: string) => {
    if (tags[k] === undefined) missing = true;
    return tags[k] ?? '';
  });
  return missing ? undefined : out;
}

/** The request context a condition reads: the session's tags, and a DynamoDB request's leading keys. */
interface Request { tags: Record<string, string>; leadingKeys?: string[] }

function conditionHolds(condition: Stmt['Condition'], req: Request): boolean {
  const valueOf = (key: string): string[] | undefined => {
    if (key.startsWith('aws:PrincipalTag/')) {
      const v = req.tags[key.slice('aws:PrincipalTag/'.length)];
      return v === undefined ? undefined : [v];
    }
    if (key === 'dynamodb:LeadingKeys') return req.leadingKeys;
    throw new Error(`the evaluator does not read the key ${key}`);
  };
  for (const [op, block] of Object.entries(condition ?? {})) {
    for (const [key, raw] of Object.entries(block)) {
      const patterns = list(raw as string | string[]).map((p) => substitute(String(p), req.tags));
      const values = valueOf(key);
      if (op === 'StringLike') {
        if (!values || !values.every((v) => patterns.some((p) => p !== undefined && glob(p, v)))) return false;
      } else if (op === 'ForAllValues:StringLike') {
        if ((values ?? []).some((v) => !patterns.some((p) => p !== undefined && glob(p, v)))) return false;
      } else if (op === 'Null') {
        if ((values === undefined || values.length === 0) !== (String(raw) === 'true')) return false;
      } else {
        throw new Error(`the evaluator does not read the operator ${op}`);
      }
    }
  }
  return true;
}

/** Whether a role's identity policy allows the request: an explicit Deny wins, then an Allow. */
function allows(roleId: string, action: string, arn: string, req: Request): boolean {
  const matches = (s: Stmt) =>
    list(s.Action).some((a) => glob(a, action))
    && list(s.Resource).some((r) => {
      const p = substitute(render(r), req.tags);
      return p !== undefined && glob(p, arn);
    })
    && conditionHolds(s.Condition, req);
  const sts = statementsOf(roleId);
  if (sts.some((s) => s.Effect === 'Deny' && matches(s))) return false;
  return sts.some((s) => s.Effect === 'Allow' && matches(s));
}

/** Whether a role's trust policy lets `principal` call `action` with these session tags. */
function trusts(roleId: string, principal: string, action: 'sts:AssumeRole' | 'sts:TagSession', tags: Record<string, string>): boolean {
  const doc = resources[roleId].Properties!.AssumeRolePolicyDocument;
  return list(doc.Statement as Stmt[]).some((s) => {
    if (s.Effect !== 'Allow' || !list(s.Action).includes(action)) return false;
    if (!list((s.Principal as { AWS?: unknown })?.AWS).some((p) => render(p) === principal)) return false;
    for (const [op, block] of Object.entries(s.Condition ?? {})) {
      for (const [key, raw] of Object.entries(block)) {
        const patterns = list(raw as string | string[]).map(String);
        if (key === 'aws:TagKeys') {
          if (op !== 'ForAllValues:StringEquals') throw new Error(`the evaluator does not read ${op} on ${key}`);
          if (Object.keys(tags).some((k) => !patterns.includes(k))) return false;
          continue;
        }
        if (!key.startsWith('aws:RequestTag/')) throw new Error(`the evaluator does not read the key ${key}`);
        const value = tags[key.slice('aws:RequestTag/'.length)];
        if (op === 'StringLike') {
          if (value === undefined || !patterns.some((p) => glob(p, value))) return false;
        } else if (op === 'StringNotLike') {
          if (value !== undefined && patterns.some((p) => glob(p, value))) return false;
        } else {
          throw new Error(`the evaluator does not read the operator ${op}`);
        }
      }
    }
    return true;
  });
}

const WRITERS = {
  profiles: { role: idOf('ProfilesTeamWriterRole', 'AWS::IAM::Role'), exec: idOf('ManageProfilesRole', 'AWS::IAM::Role'), fn: idOf('ManageProfilesFunction', 'AWS::Lambda::Function') },
  templates: { role: idOf('TemplatesTeamWriterRole', 'AWS::IAM::Role'), exec: idOf('ManageMessageTemplatesFunctionServiceRole', 'AWS::IAM::Role'), fn: idOf('ManageMessageTemplatesFunction', 'AWS::Lambda::Function') },
  experiments: { role: idOf('ExperimentsTeamWriterRole', 'AWS::IAM::Role'), exec: idOf('AdminExperimentsRole', 'AWS::IAM::Role'), fn: idOf('AdminExperimentsFunction', 'AWS::Lambda::Function') },
};
const principalOf = (roleId: string) => `{GetAtt:${roleId}.Arn}`;

// The stores' ARNs, rendered from what the EXECUTION roles name, so the requests below are built independently of the
// team writers' own grants.
const bucket = (() => {
  const s = statementsOf(WRITERS.profiles.exec).find((x) => x.Effect === 'Allow' && list(x.Resource).some((r) => render(r).endsWith('/profiles/*')));
  return render(list(s!.Resource)[0]).replace(/\/profiles\/\*$/, '');
})();
const ssmParam = (() => {
  const s = statementsOf(WRITERS.profiles.exec).find((x) => x.Effect === 'Allow' && list(x.Action).includes('ssm:LabelParameterVersion'));
  return (name: string) => render(list(s!.Resource)[0]).replace(/\/assistant\/\*\/definition$/, `/assistant/${name}`);
})();
const table = (() => {
  const s = statementsOf(WRITERS.experiments.exec).find((x) => list(x.Action).includes('dynamodb:PutItem'));
  return render(list(s!.Resource)[0]);
})();

const ADVISOR = { tags: { assistant: 'advisor' } };
const HASH = 'a'.repeat(64);

describe('the trust: the function\'s own execution role, with one assistant tag', () => {
  it.each(Object.entries(WRITERS))('%s: its execution role assumes it tagged with an assistant, on the assume and the tagging', (_n, w) => {
    expect(trusts(w.role, principalOf(w.exec), 'sts:AssumeRole', { assistant: 'advisor' })).toBe(true);
    expect(trusts(w.role, principalOf(w.exec), 'sts:TagSession', { assistant: 'advisor' })).toBe(true);
  });

  it.each(Object.entries(WRITERS))('DENIED: %s: no other function\'s role assumes it', (name, w) => {
    for (const [other, o] of Object.entries(WRITERS)) {
      if (other === name) continue;
      expect(trusts(w.role, principalOf(o.exec), 'sts:AssumeRole', { assistant: 'advisor' })).toBe(false);
    }
  });

  it.each(Object.entries(WRITERS))('DENIED: %s: an untagged assume, a tag with a slash, and a tag key it does not read', (_n, w) => {
    const exec = principalOf(w.exec);
    expect(trusts(w.role, exec, 'sts:AssumeRole', {})).toBe(false);
    expect(trusts(w.role, exec, 'sts:AssumeRole', { assistant: '' })).toBe(false);
    expect(trusts(w.role, exec, 'sts:AssumeRole', { assistant: 'advisor/../ops-premium' })).toBe(false);
    expect(trusts(w.role, exec, 'sts:TagSession', { assistant: 'advisor', classification: 'premium' })).toBe(false);
  });

  it('the profile writer alone takes an alt tag', () => {
    expect(trusts(WRITERS.profiles.role, principalOf(WRITERS.profiles.exec), 'sts:TagSession', { assistant: 'ops-premium', alt: 'alt-ops-premium' })).toBe(true);
    expect(trusts(WRITERS.templates.role, principalOf(WRITERS.templates.exec), 'sts:TagSession', { assistant: 'advisor', alt: 'alt-ops-premium' })).toBe(false);
    expect(trusts(WRITERS.experiments.role, principalOf(WRITERS.experiments.exec), 'sts:TagSession', { assistant: 'advisor', alt: 'alt-ops-premium' })).toBe(false);
  });
});

describe('the profile writer', () => {
  const w = WRITERS.profiles.role;
  const own = [
    ['ssm:PutParameter', 'definition'], ['ssm:PutParameter', 'draft'], ['ssm:PutParameter', 'advertisement'],
    ['ssm:LabelParameterVersion', 'definition'], ['ssm:DeleteParameter', 'draft'],
  ] as const;

  it('writes the tagged assistant\'s versions, draft, advertisement, bodies and golden-set hand-overs', () => {
    for (const [action, key] of own) expect([action, key, allows(w, action, ssmParam(`advisor/${key}`), ADVISOR)]).toEqual([action, key, true]);
    expect(allows(w, 's3:PutObject', `${bucket}/profiles/advisor/cfg-1/persona`, ADVISOR)).toBe(true);
    expect(allows(w, 's3:PutObject', `${bucket}/golden-uploads/premium/advisor/u-1.json`, ADVISOR)).toBe(true);
  });

  it('DENIED: every one of them for another assistant', () => {
    for (const [action, key] of own) expect([action, key, allows(w, action, ssmParam(`ops-premium/${key}`), ADVISOR)]).toEqual([action, key, false]);
    expect(allows(w, 's3:PutObject', `${bucket}/profiles/ops-premium/cfg-1/persona`, ADVISOR)).toBe(false);
    expect(allows(w, 's3:PutObject', `${bucket}/profiles/advisor-2/cfg-1/persona`, ADVISOR)).toBe(false);
    expect(allows(w, 's3:PutObject', `${bucket}/golden-uploads/premium/ops-premium/u-1.json`, ADVISOR)).toBe(false);
  });

  it('DENIED: a version label or a draft delete beyond its own, and a key a deploy or the template writer owns', () => {
    expect(allows(w, 'ssm:DeleteParameter', ssmParam('advisor/definition'), ADVISOR)).toBe(false);
    expect(allows(w, 'ssm:LabelParameterVersion', ssmParam('advisor/draft'), ADVISOR)).toBe(false);
    expect(allows(w, 'ssm:PutParameter', ssmParam('advisor/templates/_assistants/advisor/member-welcome'), ADVISOR)).toBe(false);
    expect(allows(w, 'ssm:PutParameter', ssmParam('advisor/guardrails'), ADVISOR)).toBe(false);
  });

  it('publishes a candidate in the alt it is tagged with, and only then', () => {
    const alt = { tags: { assistant: 'ops-premium', alt: 'alt-ops-premium' } };
    expect(allows(w, 'ssm:PutParameter', ssmParam('alt-ops-premium/definition'), alt)).toBe(true);
    expect(allows(w, 's3:PutObject', `${bucket}/profiles/alt-ops-premium/cfg-1/persona`, alt)).toBe(true);
    // Not activated, never another alt, and nothing in an alt without the tag.
    expect(allows(w, 'ssm:LabelParameterVersion', ssmParam('alt-ops-premium/definition'), alt)).toBe(false);
    expect(allows(w, 'ssm:PutParameter', ssmParam('alt-primary-premium/definition'), alt)).toBe(false);
    expect(allows(w, 'ssm:PutParameter', ssmParam('alt-ops-premium/definition'), { tags: { assistant: 'ops-premium' } })).toBe(false);
  });
});

describe('the template writer', () => {
  const w = WRITERS.templates.role;
  const pointer = (family: string) => ssmParam(`basic/templates/${family}member-welcome`);
  const body = (family: string) => `${bucket}/templates/basic/${family}member-welcome/${HASH}.md`;

  it('writes the tagged assistant\'s own family', () => {
    expect(allows(w, 's3:PutObject', body('_assistants/advisor/'), ADVISOR)).toBe(true);
    expect(allows(w, 'ssm:PutParameter', pointer('_assistants/advisor/'), ADVISOR)).toBe(true);
  });

  it('DENIED: another assistant\'s family (the write a wrong handler check aims), the classification\'s and the shipped', () => {
    for (const family of ['_assistants/concierge/', '', '_shipped/']) {
      expect([family, allows(w, 's3:PutObject', body(family), ADVISOR)]).toEqual([family, false]);
      expect([family, allows(w, 'ssm:PutParameter', pointer(family), ADVISOR)]).toEqual([family, false]);
    }
  });
});

describe('the experiment writer', () => {
  const w = WRITERS.experiments.role;
  const write = (action: string, ...keys: string[]) => allows(w, action, table, { ...ADVISOR, leadingKeys: keys });

  it('writes the rows stored under the tagged assistant', () => {
    for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']) expect(write(action, 'advisor.q3-tone')).toBe(true);
  });

  it('DENIED: another assistant\'s row, a row whose id carries no assistant, and a request naming no key', () => {
    for (const action of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']) {
      expect(write(action, 'ops-premium.q3-tone')).toBe(false);
      expect(write(action, 'advisor-2.q3-tone')).toBe(false);
      expect(write(action, 'q3-tone')).toBe(false);
      expect(write(action)).toBe(false);
    }
  });

  it('DENIED: reads none: a scan names no key, so it stays the execution role\'s', () => {
    expect(write('dynamodb:Scan')).toBe(false);
    expect(write('dynamodb:GetItem', 'advisor.q3-tone')).toBe(false);
  });
});

describe('each role\'s boundary and wiring', () => {
  it.each(Object.entries(WRITERS))('%s carries a permissions boundary of its own statements', (_n, w) => {
    const boundaryRef = resources[w.role].Properties!.PermissionsBoundary?.Ref;
    expect(resources[boundaryRef]?.Type).toBe('AWS::IAM::ManagedPolicy');
    const inline = list(resources[w.role].Properties!.Policies).flatMap((p: any) => list(p.PolicyDocument.Statement));
    expect(resources[boundaryRef].Properties!.PolicyDocument.Statement).toEqual(inline);
  });

  it.each(Object.entries(WRITERS))('%s: its execution role assumes it, and no other team writer, and its function is told the role', (name, w) => {
    const assumes = statementsOf(w.exec).filter((s) => s.Effect === 'Allow' && list(s.Action).includes('sts:AssumeRole'));
    expect(assumes.flatMap((s) => list(s.Resource).map(render))).toEqual([`{GetAtt:${w.role}.Arn}`]);
    for (const [other, o] of Object.entries(WRITERS)) {
      if (other !== name) expect(statementsOf(o.exec).some((s) => list(s.Resource).map(render).includes(`{GetAtt:${w.role}.Arn}`))).toBe(false);
    }
    expect(render(resources[w.fn].Properties!.Environment.Variables.TEAM_WRITER_ROLE_ARN)).toBe(`{GetAtt:${w.role}.Arn}`);
  });

  it('the execution roles keep every assistant\'s reach for an administrator\'s routes', () => {
    expect(allows(WRITERS.profiles.exec, 'ssm:PutParameter', ssmParam('ops-premium/definition'), { tags: {} })).toBe(true);
    expect(ssmParam('x')).toContain(`parameter${SSM_ROOT}/assistant/x`);
  });
});
