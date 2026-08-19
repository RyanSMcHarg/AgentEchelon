/**
 * The profile BODY store must be wired on BOTH sides, in the SYNTHESIZED template.
 *
 * SPEC-PORTABLE-PROFILES keeps a version's persona in S3 under `profiles/*` and stores a pointer in the
 * SSM definition. That splits one artifact across two services, so it has two ways to ship inert, and
 * both are silent:
 *
 *   - the WRITER (manage-profiles) without `PROFILE_BODY_BUCKET` keeps every persona INLINE. The IAM
 *     grant is present and unused, nothing errors, and the 4096-character definition cap is quietly back
 *     - which is the entire defect this indirection removes.
 *   - the READER (an async processor) without `s3:GetObject` on the prefix fails to follow the pointer.
 *     Resolution fails closed to the compiled seed, so the assistant still answers - as the GENERIC
 *     default, not as the configured persona, with no failing test anywhere.
 *
 * Unit tests cannot see either: both cross a Lambda boundary that only exists after synth. This is the
 * same class of failure as the alt-bot roster read, which shipped inert because every test exercised the
 * code and none exercised the deployment.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ExperimentsStack } from '../lib/stacks/experiments-stack';
import { BasicClassificationStack } from '../lib/stacks/basic-classification-stack';
import { DEFAULT_PROFILE_MODEL_SELECTION } from '../lib/config/model-strategy';

const env = { account: '123456789012', region: 'us-east-1' };
const APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
const BUCKET_ARN_PARAM = '/agentechelon/shared/attachments-bucket-arn';

function experimentsTemplate(props: { attachmentsBucketArnParam?: string }) {
  const app = new cdk.App();
  const stack = new ExperimentsStack(app, 'AgentEchelonExperiments', {
    env,
    appInstanceArn: APP_INSTANCE_ARN,
    userPoolId: 'us-east-1_TESTPOOL',
    ...props,
  });
  return Template.fromStack(stack).toJSON() as Record<string, never>;
}

/** The manage-profiles function, found by its entry rather than a logical id. */
function manageProfilesEnv(json: Record<string, never>): Record<string, string> {
  const resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> = json.Resources;
  const fns = Object.entries(resources).filter(([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith('ManageProfilesFunction'));
  if (fns.length !== 1) throw new Error(`expected exactly one ManageProfilesFunction, found ${fns.length}`);
  const envBlock = (fns[0][1].Properties?.Environment ?? {}) as { Variables?: Record<string, string> };
  return envBlock.Variables ?? {};
}

describe('the profile body store is wired end to end', () => {
  it('manage-profiles is granted BOTH s3 verbs on the profiles prefix', () => {
    const raw = JSON.stringify(experimentsTemplate({ attachmentsBucketArnParam: BUCKET_ARN_PARAM }));
    // Read as well as write: editing a draft, cloning the active version and exporting all read the
    // persona back. A write-only grant would land the body and then fail every subsequent edit.
    expect(raw).toContain('s3:PutObject');
    expect(raw).toContain('s3:GetObject');
    expect(raw).toContain('/profiles/*');
  });

  it('manage-profiles carries PROFILE_BODY_BUCKET, or it silently keeps personas inline', () => {
    const vars = manageProfilesEnv(experimentsTemplate({ attachmentsBucketArnParam: BUCKET_ARN_PARAM }));
    expect(Object.keys(vars)).toContain('PROFILE_BODY_BUCKET');
  });

  it('FAILS the way it is meant to: no bucket param ⇒ no env, no grant', () => {
    // Proving the two assertions above can fail. Without this, a template that never contained either
    // string would pass them by accident and the guard would be decorative.
    const json = experimentsTemplate({});
    expect(Object.keys(manageProfilesEnv(json))).not.toContain('PROFILE_BODY_BUCKET');
    expect(JSON.stringify(json)).not.toContain('/profiles/*');
  });

  it('the async processor can READ the prefix its definition points into', () => {
    const app = new cdk.App();
    const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', {
      env,
      appInstanceArn: APP_INSTANCE_ARN,
      attachmentsBucketName: 'test-bucket',
      attachmentsBucketArn: 'arn:aws:s3:::test-bucket',
      profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
    } as never);

    const json = Template.fromStack(stack).toJSON() as Record<string, never>;
    const resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> = json.Resources;

    // The grant must sit on a statement that actually carries s3:GetObject — asserting the ARN alone
    // would pass on a ListBucket-only statement, which cannot fetch a persona.
    const readsProfiles = Object.values(resources).some((r) => {
      if (r.Type !== 'AWS::IAM::Policy' && r.Type !== 'AWS::IAM::Role') return false;
      const statements = JSON.stringify(r.Properties ?? {});
      return statements.includes('s3:GetObject') && statements.includes('arn:aws:s3:::test-bucket/profiles/*');
    });
    expect(readsProfiles).toBe(true);

    // And it must know the bucket. `bodyBucket()` reads PROFILE_BODY_BUCKET ?? CONTEXT_BUCKET; the
    // processor has had CONTEXT_BUCKET since context sources, so this pins that it still does.
    const processors = Object.values(resources).filter(
      (r) => r.Type === 'AWS::Lambda::Function'
        && JSON.stringify((r.Properties?.Environment ?? {}) as object).includes('PROFILE_NAME'),
    );
    expect(processors.length).toBeGreaterThan(0);
    for (const p of processors) {
      const vars = ((p.Properties?.Environment ?? {}) as { Variables?: Record<string, string> }).Variables ?? {};
      expect(Object.keys(vars)).toContain('CONTEXT_BUCKET');
    }
  });

  it('the ROUTER can read the prefix too — its classifier model is per-profile', () => {
    // The router resolves the active version as well (SPEC-ASSISTANT-CONFIG §4 U2b: the classifier
    // model comes from the profile), and `resolveActiveProfile` fails CLOSED to the compiled seed when
    // the persona pointer cannot be followed. So a router without this env + grant does not error: it
    // classifies with the deployment default forever while the processor runs the activated version.
    // That is the third silent way this store ships inert, and it shipped exactly that way.
    const app = new cdk.App();
    const stack = new BasicClassificationStack(app, 'AgentEchelonClassification-Basic', {
      env,
      appInstanceArn: APP_INSTANCE_ARN,
      attachmentsBucketName: 'test-bucket',
      attachmentsBucketArn: 'arn:aws:s3:::test-bucket',
      profileModelSelection: DEFAULT_PROFILE_MODEL_SELECTION,
    } as never);

    const json = Template.fromStack(stack).toJSON() as Record<string, never>;
    const resources: Record<string, { Type: string; Properties?: Record<string, unknown> }> = json.Resources;

    // The router function, found by its router-only env key. It must know the bucket.
    const routers = Object.values(resources).filter(
      (r) => r.Type === 'AWS::Lambda::Function'
        && JSON.stringify((r.Properties?.Environment ?? {}) as object).includes('ONBOARDING_INTAKE_PARAM'),
    );
    expect(routers.length).toBeGreaterThan(0);
    for (const r of routers) {
      const vars = ((r.Properties?.Environment ?? {}) as { Variables?: Record<string, string> }).Variables ?? {};
      expect(Object.keys(vars)).toContain('PROFILE_BODY_BUCKET');
    }

    // And the grant must sit on the HANDLER role, not be satisfied by the processor's own grant.
    const handlerPolicies = Object.values(resources).filter((r) => {
      if (r.Type !== 'AWS::IAM::Policy') return false;
      const roles = JSON.stringify((r.Properties ?? {}).Roles ?? []);
      return roles.includes('AgentHandlerRole');
    });
    const handlerReadsProfiles = handlerPolicies.some((r) => {
      const statements = JSON.stringify(r.Properties ?? {});
      return statements.includes('s3:GetObject') && statements.includes('arn:aws:s3:::test-bucket/profiles/*');
    });
    expect(handlerReadsProfiles).toBe(true);
  });
});
