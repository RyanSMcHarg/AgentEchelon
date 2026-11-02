/**
 * How `validate.mjs` names this deployment's stacks, and how it reads a failed lookup.
 *
 * `validate.mjs` drives a live deployment, so it cannot run here. The two decisions it makes BEFORE
 * touching anything are pure, live in scripts/lib/stack-lookup.cjs, and are each a defect that has
 * shipped:
 *
 *  - the stack-name prefix was hardcoded to `AgentEchelon` behind a FATAL exit, so a deployment
 *    using any other instance name died at the frontend lookup rather than validating;
 *  - a non-zero `describe-stacks` exit was read as "the stack is absent", which is also what an
 *    expired SSO session, absent credentials, a denied call and a throttle look like. An operator
 *    was told Aurora was not deployed when the script had simply failed to ask.
 */
const {
  pascal, resolveInstanceName, resolveStackPrefix, classifyStackLookup,
} = require('../scripts/lib/stack-lookup.cjs');

describe('stack-name prefix resolution', () => {
  it('defaults to the upstream instance', () => {
    expect(resolveInstanceName({})).toBe('agent-echelon');
    expect(resolveStackPrefix({})).toBe('AgentEchelon');
  });

  it('follows the instance name the stacks themselves read', () => {
    // lib/stacks/agent-classification-common.ts derives STACK_PREFIX from AE_INSTANCE_NAME the same
    // way, so a deployment named `acme` has `AcmeChatApp`, not `AgentEchelonChatApp`.
    expect(resolveStackPrefix({ AE_INSTANCE_NAME: 'acme' })).toBe('Acme');
    expect(resolveStackPrefix({ AE_INSTANCE_NAME: 'acme-two' })).toBe('AcmeTwo');
    expect(pascal('a_b c')).toBe('ABC');
  });

  it('honors the explicit prefix override, in both spellings', () => {
    // AE_STACK_PREFIX is the stacks' own override; STACK_PREFIX is the script-only spelling deploy.mjs
    // passes to its child steps.
    expect(resolveStackPrefix({ AE_STACK_PREFIX: 'Zed', AE_INSTANCE_NAME: 'acme' })).toBe('Zed');
    expect(resolveStackPrefix({ STACK_PREFIX: 'Zed', AE_INSTANCE_NAME: 'acme' })).toBe('Zed');
    expect(resolveStackPrefix({ AE_STACK_PREFIX: 'Zed', STACK_PREFIX: 'Zed' })).toBe('Zed');
  });

  it('never derives the prefix from FRONTEND_STACK_NAME, which overrides the chat target only', () => {
    // Deriving the prefix from the chat override is what let it redirect the admin publish.
    expect(resolveStackPrefix({ FRONTEND_STACK_NAME: 'AcmeChatApp' })).toBe('AgentEchelon');
    expect(resolveStackPrefix({ FRONTEND_STACK_NAME: 'AcmeChatApp', AE_INSTANCE_NAME: 'other' })).toBe('Other');
  });

  it('reads the instance from any variable that names it: the stacks\' own and the e2e harness\'s', () => {
    expect(resolveInstanceName({ E2E_INSTANCE_NAME: 'acme' })).toBe('acme');
    expect(resolveInstanceName({ INSTANCE_NAME: 'acme' })).toBe('acme');
    expect(resolveInstanceName({ SSM_ROOT: '/acme' })).toBe('acme');
    expect(resolveInstanceName({ E2E_INSTANCE_NAME: 'acme', AE_INSTANCE_NAME: 'acme', SSM_ROOT: '/acme' })).toBe('acme');
    expect(resolveStackPrefix({ E2E_INSTANCE_NAME: 'acme-two' })).toBe('AcmeTwo');
  });

  it('refuses variables that name different instances rather than letting one win', () => {
    // A deploy or a publish resolved from the "winning" variable lands on another instance's stacks.
    expect(() => resolveInstanceName({ E2E_INSTANCE_NAME: 'acme', AE_INSTANCE_NAME: 'other' }))
      .toThrow(/AE_INSTANCE_NAME=other, E2E_INSTANCE_NAME=acme name different instances/);
    expect(() => resolveInstanceName({ AE_INSTANCE_NAME: 'acme', SSM_ROOT: '/other' })).toThrow(/different instances/);
    expect(() => resolveStackPrefix({ AE_STACK_PREFIX: 'Zed', STACK_PREFIX: 'Acme' })).toThrow(/different instances/);
  });

  it('is the one resolver every operator script uses', () => {
    // deploy-guards.cjs (deploy.mjs, deploy-frontend.mjs) re-exports it rather than deriving its own.
    const guards = require('../scripts/lib/deploy-guards.cjs');
    expect(guards.resolveInstancePrefix).toBe(resolveStackPrefix);
    const fs = require('fs');
    const path = require('path');
    for (const script of ['sync-context.mjs', 'gen-frontend-env.mjs', 'validate.mjs']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', script), 'utf8');
      expect(src).toMatch(/require\('\.\/lib\/stack-lookup\.cjs'\)/);
      expect(src).toMatch(/resolveStackPrefix\(process\.env\)/);
      // No script falls back to its own default prefix.
      expect(src).not.toMatch(/STACK_PREFIX \|\| 'AgentEchelon'|\|\| 'AgentEchelon'/);
    }
  });

  it('ignores an empty override rather than resolving to an empty prefix', () => {
    expect(resolveStackPrefix({ AE_STACK_PREFIX: '   ', AE_INSTANCE_NAME: 'acme' })).toBe('Acme');
    expect(resolveInstanceName({ E2E_INSTANCE_NAME: '' })).toBe('agent-echelon');
  });
});

describe('describe-stacks result classification', () => {
  it('reports a successful lookup as present', () => {
    expect(classifyStackLookup({ status: 0 }).presence).toBe('present');
  });

  it('reports a genuinely missing stack as absent', () => {
    const r = classifyStackLookup({
      status: 254,
      stderr: 'An error occurred (ValidationError) when calling the DescribeStacks operation: '
        + 'Stack with id AcmeArchive does not exist',
    });
    expect(r.presence).toBe('absent');
  });

  it.each([
    ['an expired session', 'An error occurred (ExpiredToken) when calling the DescribeStacks operation: The security token included in the request is expired'],
    ['an expired SSO cache', 'Error loading SSO Token: Token for https://example.awsapps.com/start does not exist'],
    ['no credentials at all', 'Unable to locate credentials. You can configure credentials by running "aws configure".'],
    ['a denied call', 'An error occurred (AccessDenied) when calling the DescribeStacks operation: User is not authorized'],
    ['a throttle', 'An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded'],
    ['no network', 'Could not connect to the endpoint URL: "https://cloudformation.us-east-1.amazonaws.com/"'],
  ])('reports %s as unknown, never as absent', (_label, stderr) => {
    const r = classifyStackLookup({ status: 255, stderr });
    // "Could not ask" and "is not there" have different fixes. Reporting the first as the second
    // sends the operator to redeploy infrastructure that is fine.
    expect(r.presence).toBe('unknown');
    expect(r.why).toBeTruthy();
  });

  it('treats an unrecognised failure as unknown, because an exit code alone proves nothing', () => {
    expect(classifyStackLookup({ status: 1, stderr: '' }).presence).toBe('unknown');
    expect(classifyStackLookup({ status: null, error: new Error('spawnSync aws ENOENT') }).presence).toBe('unknown');
  });

  it('is not fooled by a stack NAME that contains one of the session-failure words', () => {
    // The absent pattern is anchored on the error CODE, so a deployment whose prefix yields
    // `<Prefix>CredentialExchange` still reads as absent rather than as an auth problem.
    const r = classifyStackLookup({
      status: 254,
      stderr: 'An error occurred (ValidationError) when calling the DescribeStacks operation: '
        + 'Stack with id AcmeCredentialExchange does not exist',
    });
    expect(r.presence).toBe('absent');
  });
});
