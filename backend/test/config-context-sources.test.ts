/**
 * Context source catalog SHAPE gate (SPEC-CONTEXT-SOURCES-AND-STORES section 3/4, phase 1).
 *
 * Every case here asserts a REJECTION as well as the happy path. A validator that only proves valid
 * input passes is the guard shape this codebase has been bitten by twice - it cannot distinguish
 * "correct" from "checking nothing".
 */
import {
  validateContextSourceCatalog,
  assertValidContextSourceCatalog,
  loadContextSourceCatalog,
  RESERVED_CONTRACTS,
  DEPLOYMENT_KEY_PREFIX,
  type ContextSourceEntry,
} from '../lib/config/context-sources';

/** A minimal VALID entry; each test perturbs exactly one thing so the failure is attributable. */
function entry(over: Partial<ContextSourceEntry> = {}): ContextSourceEntry {
  return {
    key: 'user-profile',
    title: 'About this person',
    description: 'Who the signed-in user is and what they told us at onboarding',
    useWhen: 'Personalising a greeting, or tailoring an answer to their company',
    type: 'lambda-service',
    arn: 'arn:aws:lambda:us-east-1:123456789012:function:profile',
    // The ARN is the GRANT resource; the locator is the name the reader resolves. Separate because
    // the ARN is usually a CloudFormation token and cannot be sliced at synth time.
    locator: 'profile',
    trust: 'platform',
    availability: 'identity-settled',
    maxBytes: 4096,
    fields: { displayName: { type: 'string', description: 'Preferred name for addressing them' } },
    ...over,
  };
}

describe('context source catalog validation', () => {
  it('accepts a well-formed reserved entry', () => {
    expect(validateContextSourceCatalog([entry()])).toEqual([]);
  });

  it('accepts a deployment-defined key under the x- prefix', () => {
    const e = entry({ key: 'x-resume', fields: { headline: { type: 'string', description: 'Top line' } } });
    expect(validateContextSourceCatalog([e])).toEqual([]);
  });

  describe('the scannable layer is required, not best-effort', () => {
    // These are what a human reads to configure and a model reads to CHOOSE. A source without them
    // is unusable by both, so absence is a build failure rather than a lint.
    it.each(['title', 'description', 'useWhen'] as const)('rejects a missing %s', (field) => {
      const errors = validateContextSourceCatalog([entry({ [field]: '' })]);
      expect(errors).toContainEqual({ key: 'user-profile', problem: `${field} is required` });
    });

    it('rejects a field with no description', () => {
      const e = entry({ fields: { displayName: { type: 'string', description: '  ' } } });
      expect(validateContextSourceCatalog(e ? [e] : [])).toContainEqual({
        key: 'user-profile',
        problem: "field 'displayName' needs a description",
      });
    });
  });

  describe('reserved contracts', () => {
    it('rejects a reserved key missing a required field', () => {
      // user-profile without displayName: the contract other deployments rely on is broken.
      const e = entry({ fields: { company: { type: 'string', description: 'Employer' } } });
      expect(validateContextSourceCatalog([e])).toContainEqual({
        key: 'user-profile',
        problem: "reserved key must declare field 'displayName'",
      });
    });

    it('allows a reserved key to ADD fields beyond its contract', () => {
      const e = entry({
        fields: {
          displayName: { type: 'string', description: 'Preferred name' },
          pronouns: { type: 'string', optional: true, description: 'How they are referred to' },
        },
      });
      expect(validateContextSourceCatalog([e])).toEqual([]);
    });

    it('rejects an unknown key that is not namespaced', () => {
      const errors = validateContextSourceCatalog([entry({ key: 'resume' })]);
      expect(errors[0].problem).toMatch(/unknown key/);
      expect(errors[0].problem).toContain(DEPLOYMENT_KEY_PREFIX);
    });

    it('every reserved contract is itself satisfiable (no contract requires a field it forbids)', () => {
      for (const [key, contract] of Object.entries(RESERVED_CONTRACTS)) {
        const fields = Object.fromEntries(
          contract.requiredFields.map((f) => [f, { type: 'string' as const, description: `the ${f}` }]),
        );
        const e = entry({
          key,
          fields: Object.keys(fields).length ? fields : { note: { type: 'string', description: 'x' } },
        });
        expect(validateContextSourceCatalog([e])).toEqual([]);
      }
    });
  });

  describe('shape rules', () => {
    it('rejects an s3-prefix entry with no prefix', () => {
      const e = entry({ key: 'company-docs', type: 's3-prefix', arn: 'arn:aws:s3:::b', prefix: '',
        fields: { digest: { type: 'string', description: 'menu' } } });
      expect(validateContextSourceCatalog([e])).toContainEqual({
        key: 'company-docs', problem: "type 's3-prefix' requires a prefix",
      });
    });

    it('rejects a missing arn', () => {
      expect(validateContextSourceCatalog([entry({ arn: '' })]))
        .toContainEqual({ key: 'user-profile', problem: 'arn is required (the IAM grant resource)' });
    });

    // The two are separate fields for a reason: the ARN is the grant resource and is usually a CFN
    // token, the locator is the name the reader resolves. An entry with a grant but no locator would
    // publish, be authorised, and read nothing.
    it('rejects a missing locator', () => {
      expect(validateContextSourceCatalog([entry({ locator: '' })]))
        .toContainEqual({ key: 'user-profile', problem: 'locator is required (the name the reader resolves)' });
    });

    it('rejects a non-positive maxBytes', () => {
      expect(validateContextSourceCatalog([entry({ maxBytes: 0 })]))
        .toContainEqual({ key: 'user-profile', problem: 'maxBytes must be a positive number' });
    });

    it('rejects an entry with no fields', () => {
      expect(validateContextSourceCatalog([entry({ fields: {} })]))
        .toContainEqual({ key: 'user-profile', problem: 'at least one field is required' });
    });

    it('rejects a duplicate key', () => {
      expect(validateContextSourceCatalog([entry(), entry()]))
        .toContainEqual({ key: 'user-profile', problem: 'duplicate key' });
    });
  });

  it('reports EVERY problem at once, so a deployer fixes the file in one pass', () => {
    const errors = validateContextSourceCatalog([entry({ title: '', arn: '', maxBytes: -1 })]);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  // The loader is what a deploy actually calls. Its contract: fall back to the tracked example when
  // the deployer has no local file, and NEVER silently yield an empty catalog for any other reason -
  // an assistant deployed with no context because a config file failed to parse is a silent outage.
  describe('loadContextSourceCatalog', () => {
    it('falls back to the tracked example on a clean clone, and the example is valid', () => {
      const { entries, source } = loadContextSourceCatalog({ classification: 'standard', attachmentsBucketArn: 'arn:aws:s3:::test-bucket', attachmentsBucketName: 'test-bucket', userProfileTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/UserProfile', userProfileTableName: 'UserProfile', region: 'us-east-1', account: '123456789012' });
      expect(source).toContain('context-sources.example');
      expect(entries.length).toBeGreaterThan(0);
      expect(validateContextSourceCatalog(entries)).toEqual([]);
    });

    it('scopes s3-prefix entries to the classification it was asked for', () => {
      // The isolation boundary is per classification; a catalog that ignored its argument would hand
      // every classification the same prefix, which is the leak this design exists to prevent.
      const standard = loadContextSourceCatalog({ classification: 'standard', attachmentsBucketArn: 'arn:aws:s3:::test-bucket', attachmentsBucketName: 'test-bucket', userProfileTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/UserProfile', userProfileTableName: 'UserProfile', region: 'us-east-1', account: '123456789012' }).entries.find((e) => e.key === 'company-docs');
      const basic = loadContextSourceCatalog({ classification: 'basic', attachmentsBucketArn: 'arn:aws:s3:::test-bucket', attachmentsBucketName: 'test-bucket', userProfileTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/UserProfile', userProfileTableName: 'UserProfile', region: 'us-east-1', account: '123456789012' }).entries.find((e) => e.key === 'company-docs');
      expect(standard?.prefix).toBe('context/standard/');
      expect(basic?.prefix).toBe('context/basic/');
    });

    it('the example marks user-profile unreadable at welcome time', () => {
      // WelcomeIntent fires before the creator's membership settles, so this must not be `always` -
      // mislabelling it does not cause a wait, it puts a wrong or empty name in the first message.
      const e = loadContextSourceCatalog({ classification: 'standard', attachmentsBucketArn: 'arn:aws:s3:::test-bucket', attachmentsBucketName: 'test-bucket', userProfileTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/UserProfile', userProfileTableName: 'UserProfile', region: 'us-east-1', account: '123456789012' }).entries.find((s) => s.key === 'user-profile');
      expect(e?.availability).toBe('identity-settled');
    });
  });

  describe('assertValidContextSourceCatalog', () => {
    it('throws naming the source and every reason', () => {
      expect(() => assertValidContextSourceCatalog([entry({ title: '', arn: '' })], 'my-catalog.ts'))
        .toThrow(/my-catalog\.ts[\s\S]*title is required[\s\S]*arn is required/);
    });

    it('does not throw on a valid catalog', () => {
      expect(() => assertValidContextSourceCatalog([entry()], 'ok.ts')).not.toThrow();
    });
  });
});
