/**
 * Resolving this deployment's CloudFormation stacks from operator tooling.
 *
 * Two questions live here because both have been answered wrongly in a script, and both failures
 * look like a broken deployment rather than a broken lookup.
 *
 * 1. WHAT ARE THIS DEPLOYMENT'S STACKS CALLED. Every stack id in `bin/backend.ts` is
 *    `${STACK_PREFIX}<Name>`, and `STACK_PREFIX` (lib/stacks/agent-classification-common.ts) is
 *    `AE_STACK_PREFIX`, or the PascalCase form of `AE_INSTANCE_NAME`. A script that hardcodes
 *    `AgentEchelon` works only on the default instance and fails on every other one - and it fails
 *    at the point of use, naming a stack the deployer never created.
 *
 *    The rest of the tooling already resolves this, each in its own way: `gen-frontend-env.mjs`
 *    reads `STACK_PREFIX`, `deploy.mjs` derives it from `FRONTEND_STACK_NAME` (and overrides with
 *    `AE_DEPLOY_STACK_PREFIX`). This function knows all of them, so one deployment gets one answer.
 *
 * 2. DID THE LOOKUP SAY "ABSENT", OR DID IT FAIL TO ASK. `aws cloudformation describe-stacks`
 *    exits non-zero for a stack that does not exist AND for an expired SSO session, absent
 *    credentials, a denied call, a throttle, or no network. Reading the exit code alone reports
 *    "not deployed" for a stack that is deployed and healthy, which sends the operator to redeploy
 *    infrastructure that is fine.
 */

/** `acme-two` -> `AcmeTwo`. Mirrors `pascal()` in lib/stacks/agent-classification-common.ts. */
function pascal(s) {
  return String(s)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * This deployment's instance name (the SSM root without its leading slash).
 *
 * `E2E_INSTANCE_NAME` and `INSTANCE_NAME` come first because the e2e harness sets them; the stacks
 * themselves read `AE_INSTANCE_NAME`.
 */
function resolveInstanceName(env = process.env) {
  const raw = env.E2E_INSTANCE_NAME
    || env.INSTANCE_NAME
    || env.AE_INSTANCE_NAME
    || (env.SSM_ROOT || '').replace(/^\//, '')
    || 'agent-echelon';
  return String(raw).trim() || 'agent-echelon';
}

/**
 * This deployment's CloudFormation stack-name prefix, e.g. `AgentEchelon` or `Acme`.
 *
 * An explicit prefix wins over anything derived, so a deployment whose stack names do not follow
 * the instance name at all still resolves without editing a script.
 */
function resolveStackPrefix(env = process.env) {
  const explicit = (env.AE_STACK_PREFIX || env.STACK_PREFIX || '').trim();
  if (explicit) return explicit;
  const frontendStack = (env.FRONTEND_STACK_NAME || '').trim();
  if (frontendStack) return frontendStack.replace(/Frontend$/, '');
  return pascal(resolveInstanceName(env));
}

/**
 * The AWS CLI's message for a stack that is genuinely not there. Anchored on the error CODE as well
 * as the phrase: "does not exist" on its own also appears in `Error loading SSO Token: Token for
 * <url> does not exist`, which is an expired session and the opposite conclusion.
 */
const ABSENT = /\(ValidationError\)[\s\S]*does not exist/i;

/**
 * The lookup could not be made. Every one of these means the stack's presence is UNKNOWN, which is
 * a different report from "absent" and has a different fix (repair the session, not the stack).
 */
const CANNOT_ASK = new RegExp(
  [
    'ExpiredToken',
    'expired',
    'credential',
    '\\bsso\\b',
    'AccessDenied',
    'UnauthorizedOperation',
    'UnrecognizedClient',
    'InvalidClientTokenId',
    'Throttl',
    'RequestLimitExceeded',
    'Unable to locate credentials',
    'could not connect',
    'EndpointConnectionError',
    'ConnectTimeout',
    'ENOTFOUND',
    'ENOENT',
    'getaddrinfo',
  ].join('|'),
  'i',
);

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

/**
 * Classify a `describe-stacks` result as present / absent / unknown.
 *
 * Accepts a `spawnSync` result directly (`{ status, stderr, error }`). `unknown` is the default for
 * an unrecognised failure: an exit code on its own never proves a stack is missing.
 */
function classifyStackLookup(result = {}) {
  const { status, stderr, error } = result;
  if (status === 0) return { presence: 'present', why: '' };
  const text = `${stderr || ''} ${error ? error.message || error : ''}`;
  // ABSENT is tested FIRST because it is the precise pattern: it carries the error CODE, so it
  // cannot be triggered by a stack NAME that happens to contain one of the words below (a
  // deployment whose prefix yields `<Prefix>CredentialExchange`, for instance).
  if (ABSENT.test(text)) return { presence: 'absent', why: firstLine(text) };
  if (CANNOT_ASK.test(text)) return { presence: 'unknown', why: firstLine(text) };
  return {
    presence: 'unknown',
    why: firstLine(text) || `describe-stacks exited ${status === null ? 'without a status' : status}`,
  };
}

module.exports = { pascal, resolveInstanceName, resolveStackPrefix, classifyStackLookup };
