/**
 * COMPANY CONTEXT IS READ PER ROLE, NOT PER CLASSIFICATION (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION
 * Phase 1b, the S3 context edge).
 *
 * Premium grants basic, standard and premium context. Its `ops` role is scoped to basic and standard
 * (`roleContext` in profiles.ts), so an operations assistant reads the directory and the runbooks but not
 * the financials, board summary, accounts or competitive intel. These pin the declaration, the resolver
 * both IAM and the reader use, the acting role's role-conditioned statements, and that the shared
 * processor role holds no `context/` grant. The live deny-test is `an-ops-role-reaches-only-its-own-classification.spec.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { roleContextStatements } from '../../lib/stacks/agent-classification-common';

const BUCKET = 'arn:aws:s3:::context-bucket';

describe('a role reads only its own context', () => {
  it('scopes the ops role to basic and standard context, and the primary to everything premium grants', () => {
    expect(profiles.contextPrefixesForRole('premium', 'ops')).toEqual(['context/basic/', 'context/standard/']);
    expect(profiles.contextPrefixesForRole('premium', 'primary')).toEqual(profiles.contextPrefixesGranted('premium'));
    expect(profiles.contextPrefixesForRole('premium', 'primary')).toContain('context/premium/');
  });

  it('never widens a role past its classification', () => {
    for (const c of ['basic', 'standard', 'premium']) {
      const granted = profiles.contextPrefixesGranted(c);
      for (const role of profiles.rolesFor(c)) {
        for (const p of profiles.contextPrefixesForRole(c, role)) expect(granted).toContain(p);
      }
    }
  });

  // One acting role holds every assistant role's context, each prefix conditioned on the session's
  // `role` tag being one of the roles `roleContext` gives it.
  const statementFor = (prefix: string) => roleContextStatements('premium', ['primary', 'ops'], BUCKET)
    .map((s) => s.toStatementJson())
    .find((s) => JSON.stringify(s.Resource).includes(`${BUCKET}/${prefix}*`));

  it('lets the ops role read basic and standard context, and not premium\'s', () => {
    expect(statementFor('context/basic/')?.Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['primary', 'ops']);
    expect(statementFor('context/standard/')?.Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['primary', 'ops']);
    expect(statementFor('context/premium/')?.Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['primary']);
  });

  it('writes one list and one read statement per reader group, not per prefix', () => {
    // Premium with an ops role has two reader groups: basic and standard (primary, ops) and premium (primary).
    const statements = roleContextStatements('premium', ['primary', 'ops'], BUCKET).map((s) => s.toStatementJson());
    expect(statements).toHaveLength(4);
    expect(statementFor('context/basic/')).toEqual(statementFor('context/standard/'));
    expect(statementFor('context/basic/')).not.toEqual(statementFor('context/premium/'));
  });

  it('grants nothing to a session with no role tag', () => {
    for (const s of roleContextStatements('premium', ['primary', 'ops'], BUCKET).map((x) => x.toStatementJson())) {
      expect(s.Effect).toBe('Allow');
      expect(s.Condition.StringEquals['aws:PrincipalTag/role']).toBeDefined();
    }
  });

  it('leaves the shared processor role with no company context grant', () => {
    const stack = fs.readFileSync(path.join(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');
    const start = stack.indexOf('ContextS3Read: new iam.PolicyDocument({');
    expect(start).toBeGreaterThan(-1);
    const shared = stack.slice(start, stack.indexOf('}),\n', stack.indexOf("`${props.attachmentsBucketArn}/profiles/*`", start)));
    expect(shared).not.toContain('contextPrefixesAllowedFor');
    expect(shared).toContain('platformGrantedPrefixes');
  });

  it('reads platform knowledge only under the prefixes its classification grants, on both IAM layers', () => {
    // Platform documentation is internal material: the external classification is granted
    // a public overview, and neither the role nor the vended session reaches `platform-knowledge/*` wholesale.
    const stack = fs.readFileSync(path.join(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');
    expect(stack).toContain('const platformGrantedPrefixes = defaultProfileRegistry.grantsFor(classification).map((c) => `platform-knowledge/${c}/`)');
    expect(stack).not.toContain('`${props.attachmentsBucketArn}/platform-knowledge/*`');
    const common = fs.readFileSync(path.join(__dirname, '../../lib/stacks/agent-classification-common.ts'), 'utf8');
    expect(common).toContain('PLATFORM_PREFIXES = profiles.grantsFor(opts.classification)');
    expect(common).toContain("actions: ['s3:GetObject'], resources: PLATFORM_OBJECT_ARNS");
  });

  it("grants a catalog source under context/ to no shared role, and reads it on the assistant's credentials", () => {
    // The catalog's `company-docs` source points at `context/{classification}/`: a second path to the same
    // documents, which the live deny-test caught still granted on the shared role.
    const stack = fs.readFileSync(path.join(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');
    const loop = stack.slice(stack.indexOf('for (const entry of contextSources.entries)'), stack.indexOf('contextSourceGrant(entry)'));
    expect(loop).toMatch(/startsWith\('context\/'\)\) continue;/);
    const processor = fs.readFileSync(path.join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    expect(processor).toContain('companyContextScope(CLASSIFICATION)');
    expect(processor).toMatch(/isCompanyContext\(entry\) \? roleContextRead\(entry\) : sharedRead\(entry\)/);
  });
});
