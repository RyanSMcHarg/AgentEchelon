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
 *    `resolveStackPrefix` below is the one resolver for every operator script: `deploy.mjs`,
 *    `deploy-frontend.mjs` (both through `resolveInstancePrefix` in `deploy-guards.cjs`, which is
 *    this function), `sync-context.mjs`, `gen-frontend-env.mjs` and `validate.mjs`. It never reads
 *    `FRONTEND_STACK_NAME`: that variable overrides the chat frontend target only, and deriving the
 *    prefix from it is what let a chat override redirect the admin publish.
 *
 *    `STACK_PREFIX` is a script-only spelling of the override. The CDK app reads `AE_STACK_PREFIX`
 *    and `AE_INSTANCE_NAME`, never `STACK_PREFIX`, so setting `STACK_PREFIX` alone points the scripts
 *    at a prefix the stacks do not have. `deploy.mjs` sets it for its child steps to the prefix it
 *    resolved, which is its intended use.
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
 * The set values among `names`, trimmed, or throw when two of them disagree.
 *
 * Each variable is a way of naming the same thing. Two that name different things leave no right
 * answer: picking one by precedence points a script at an instance the deployer may not have meant,
 * and for a deploy or a publish that is another instance's stacks.
 */
function agreedValue(env, names, read = (v) => v) {
  const set = names
    .map((name) => ({ name, value: String(read(env[name] || '')).trim() }))
    .filter((v) => v.value);
  const distinct = [...new Set(set.map((v) => v.value))];
  if (distinct.length > 1) {
    throw new Error(
      `${set.map((v) => `${v.name}=${env[v.name]}`).join(', ')} name different instances.\n`
        + '   Set them to the same value, or unset all but one.',
    );
  }
  return distinct[0] || '';
}

/**
 * This deployment's instance name (the SSM root without its leading slash).
 *
 * The stacks read `AE_INSTANCE_NAME`; the e2e harness sets `E2E_INSTANCE_NAME`, `INSTANCE_NAME` or
 * `SSM_ROOT`. Any of them names the instance, and two that disagree throw rather than one silently
 * winning.
 */
function resolveInstanceName(env = process.env) {
  const fromSsmRoot = (v) => String(v).trim().replace(/^\//, '');
  return agreedValue(env, INSTANCE_VARIABLES, fromSsmRoot) || DEFAULT_INSTANCE;
}

/** The variables that name the instance, in the order `resolveInstanceName` reads them. */
const INSTANCE_VARIABLES = ['AE_INSTANCE_NAME', 'E2E_INSTANCE_NAME', 'INSTANCE_NAME', 'SSM_ROOT'];

/** The instance a deployment is when none is named: the dev deployment (`INSTANCE_NAME` in agent-classification-common.ts). */
const DEFAULT_INSTANCE = 'agent-echelon';

/**
 * This deployment's CloudFormation stack-name prefix, e.g. `AgentEchelon` or `Acme`.
 *
 * `AE_STACK_PREFIX` (or the script-only `STACK_PREFIX`) wins over anything derived, matching
 * `STACK_PREFIX` in lib/stacks/agent-classification-common.ts; otherwise the PascalCase of the
 * instance name. Throws when two variables disagree.
 */
function resolveStackPrefix(env = process.env) {
  const explicit = agreedValue(env, ['AE_STACK_PREFIX', 'STACK_PREFIX']);
  if (explicit) return explicit;
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

/**
 * THE STACKS THIS APP CREATES, as the part of the name after the instance prefix. The names come from
 * `lib/config/stack-names.json`, the one list `bin/backend.ts` names its stacks from.
 *
 * A prefix alone does not identify an instance: instance `Acme` has prefix `Acme`, and so does every
 * stack of instance `AcmeTwo`. Matching on `startsWith(prefix)` reads `AcmeTwoConversations` as one of
 * Acme's stacks and merges another instance's outputs into this one's frontend env. So a stack
 * belongs to the instance only when the rest of its name is one of the names the app gives its stacks.
 * `a-stack-belongs-to-its-own-instance.test.ts` keeps the list equal to the ids the app creates.
 */
const STACK_NAMES = JSON.parse(
  require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'lib', 'config', 'stack-names.json'), 'utf8'),
);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An exact-name pattern over `names`, plus `perName` families each followed by a lowercase word. */
function suffixPattern(names, families) {
  return new RegExp(
    '^(?:' + [
      ...names.map(escapeRe),
      ...families.map((f) => `${escapeRe(f)}[a-z0-9-]+`),
    ].join('|') + ')$',
  );
}

const INSTANCE_STACK_SUFFIX = suffixPattern(
  [...STACK_NAMES.current, ...STACK_NAMES.testOnly],
  [STACK_NAMES.perClassification, STACK_NAMES.perRegion],
);

/** True when `stackName` is one of the stacks this app creates for the instance with `prefix`. */
function isInstanceStack(stackName, prefix) {
  const name = String(stackName || '');
  if (!prefix || !name.startsWith(prefix)) return false;
  return INSTANCE_STACK_SUFFIX.test(name.slice(prefix.length));
}

module.exports = {
  pascal, resolveInstanceName, resolveStackPrefix, classifyStackLookup, isInstanceStack, INSTANCE_STACK_SUFFIX, STACK_NAMES, suffixPattern,
  INSTANCE_VARIABLES, DEFAULT_INSTANCE,
};
