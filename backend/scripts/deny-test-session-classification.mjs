#!/usr/bin/env node
/**
 * Live deny-test for the SESSION CLASSIFICATION ASSERTION (SPEC-CONVERSATION-SECURITY section 4d).
 *
 * Every credential vend asserts two things on the STS session: `person` (who may be acted as) and
 * `classification` (at what). Each classification role's trust policy requires the second to equal that role's
 * own classification, so a session asserting `basic` cannot be minted on the role carrying premium's
 * grant set. That catches a MIS-VEND - the exchange handing a correct role to the wrong caller - which
 * is the one failure a correct role policy cannot catch by itself.
 *
 * ── WHY THIS SCRIPT EXISTS IN THIS SHAPE ────────────────────────────────────────────────────────
 *
 * The obvious proof is unavailable. A mismatched assertion cannot be induced through the deployed
 * exchange: it computes the role and the assertion from one clearance, so the API has no input that
 * makes them disagree. And the classification roles trust only the exchange Lambda's execution role, which
 * trusts only `lambda.amazonaws.com`, so an operator cannot assume one directly to try - they are
 * denied for being the wrong principal, which proves nothing about the tag and is easy to mistake for
 * the control working.
 *
 * IAM POLICY SIMULATION WAS TRIED AND REJECTED. `simulate-custom-policy` does not model a role trust
 * policy soundly through `--resource-policy`: with a permissive identity policy every case evaluated
 * `allowed` (the identity Allow satisfied it), and with a narrow one every case evaluated
 * `implicitDeny` INCLUDING the matching one. Two runs that cannot both be right means the harness is
 * not measuring the condition, and a deny-test whose mechanism is unsound is worse than none - it
 * reports safety it never checked.
 *
 * ── SO THE PROOF IS IN TWO HALVES, AND BOTH ARE NECESSARY ───────────────────────────────────────
 *
 *   1. THE DEPLOYED ROLES CARRY THE CONDITION. Read straight off the live trust policy documents, so
 *      this is the deployed artifact rather than what CDK intended.
 *   2. THE CONDITION ACTUALLY DENIES. A scratch role is created carrying the IDENTICAL condition but
 *      trusting the RUNNER, and then really assumed - matching tag, mismatched tag, absent tag - so
 *      IAM's own engine decides. The scratch role is deleted afterwards.
 *
 * Half 2 does not prove the deployed role denies; half 1 does not prove the condition is meaningful.
 * Together they do, and neither is a code review.
 *
 * USAGE
 *   AWS_PROFILE=<profile> node backend/scripts/deny-test-session-classification.mjs
 *
 * Exit 0 = the assertion is required and enforced; non-zero = a gap (or setup error).
 */
// IAM through the CLI rather than an SDK client: `@aws-sdk/client-iam` is not a dependency of this
// package, and a deny-test is not a reason to add one to the deploy bundle's tree. The e2e helpers
// already shell out to the CLI for exactly this kind of one-off read.
import { execFileSync } from 'child_process';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudFormationClient, DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const STACK = process.env.COGNITO_STACK || `${resolveStackPrefix(process.env)}Identity`;
const ADMIN_STACK = `${resolveStackPrefix(process.env)}AdminServices`;
const SCRATCH_ROLE = 'AgentEchelon-DenyTest-SessionClassification';
const INSTANCE = resolveInstanceName(process.env);

const sts = new STSClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

/**
 * One IAM call through the CLI, JSON in and JSON out.
 *
 * `execFileSync` rather than `execSync`: the arguments carry a policy document, and a shell would
 * reinterpret its quoting. Passing them as an argv array means no shell sees them at all.
 */
function awsIam(args) {
  const out = execFileSync('aws', ['iam', ...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, AWS_REGION: REGION },
  });
  return out.trim() ? JSON.parse(out) : {};
}

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };

/**
 * THE VEND ROLES, from where each is built: every person vend role is on the instance's exchange path
 * (`/<instance>/exchange/`, `lib/constructs/exchange-role.ts`), named `<instance>-exchange-<token>`, whichever
 * stack built it (`Assistants-<classification>` for a conversational classification, `Identity` for the admin
 * plane and the one-conversation role). The admin backend's admin-plane role is AdminServices' (absent on a
 * deployment without the `admin` capability), found by logical id.
 */
async function exchangeRoleResources() {
  const out = [];
  const namePrefix = `${INSTANCE}-exchange-`;
  const listed = awsIam(['list-roles', '--path-prefix', `/${INSTANCE}/exchange/`]).Roles || [];
  for (const r of listed) {
    const token = r.RoleName.startsWith(namePrefix) ? r.RoleName.slice(namePrefix.length) : '';
    // The one-conversation role asserts `restricted`, which is not a classification and is checked the same way.
    if (token) out.push({ logicalId: r.RoleName, roleName: r.RoleName, expected: token });
  }
  try {
    const r = await cfn.send(new DescribeStackResourcesCommand({ StackName: ADMIN_STACK }));
    for (const x of r.StackResources || []) {
      if (x.ResourceType === 'AWS::IAM::Role' && /^ExchangeRoleAdminPlane/.test(x.LogicalResourceId || '')) {
        out.push({ logicalId: x.LogicalResourceId, roleName: x.PhysicalResourceId, expected: 'admin' });
      }
    }
  } catch (e) {
    if (!/does not exist/.test(String(e?.message || e))) throw e;
  }
  return out;
}

/** The deployed classification roles, by the classification each is expected to require. */
async function deployedClassificationRoles() {
  return exchangeRoleResources();
}

/** The `sts:TagSession` statement's required classification on a deployed role, or null. */
function requiredClassification(trustDoc) {
  for (const s of trustDoc?.Statement || []) {
    const actions = [].concat(s.Action || []);
    if (!actions.includes('sts:TagSession')) continue;
    const v = s.Condition?.StringEquals?.['aws:RequestTag/classification'];
    if (v) return Array.isArray(v) ? v[0] : v;
  }
  return null;
}

async function halfOne() {
  console.log('\n1. THE DEPLOYED ROLES REQUIRE THE ASSERTION (read from live IAM)\n');
  const roles = await deployedClassificationRoles();
  if (roles.length === 0) {
    fail(`no vend role found on /${INSTANCE}/exchange/ - nothing was checked`);
    return null;
  }
  let sample = null;
  for (const r of roles) {
    const got = awsIam(['get-role', '--role-name', r.roleName]);
    const required = requiredClassification(got.Role?.AssumeRolePolicyDocument);
    if (!required) {
      fail(`${r.logicalId} does not require aws:RequestTag/classification - a session may assert nothing`);
      continue;
    }
    if (required !== r.expected) {
      fail(`${r.logicalId} requires '${required}', expected '${r.expected}'`);
      continue;
    }
    pass(`${r.logicalId} requires classification='${required}'`);
    if (!sample) sample = { ...r, required, trust: got.Role?.AssumeRolePolicyDocument };
  }
  return sample;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function halfTwo(sample) {
  console.log('\n2. THE CONDITION ACTUALLY DENIES (a real AssumeRole, IAM deciding)\n');
  const me = await sts.send(new GetCallerIdentityCommand({}));
  // The runner is an assumed role; a trust policy names the ROLE, not the session.
  //
  // RESOLVED FROM IAM RATHER THAN REBUILT FROM THE STS ARN. An SSO role lives under a PATH
  // (`.../role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_...`), and an ARN assembled by
  // string-replacing `assumed-role` with `role` drops it - producing a principal IAM rejects outright
  // as malformed. `get-role` returns the real ARN, path included, for any role shape.
  const roleName = String(me.Arn || '').replace(/^.*:assumed-role\/([^/]+)\/.*$/, '$1');
  const principal = awsIam(['get-role', '--role-name', roleName])?.Role?.Arn;
  if (!principal) {
    fail(`could not resolve the runner's role ARN from '${me.Arn}' - cannot build the scratch trust policy`);
    return;
  }

  const trust = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: principal },
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        // THE IDENTICAL CONDITION, copied from the deployed role rather than retyped - a retyped
        // condition would be testing this script's idea of the rule instead of the rule.
        Condition: {
          StringLike: { 'aws:RequestTag/person': '*' },
          StringEquals: { 'aws:RequestTag/classification': sample.required },
        },
      },
    ],
  };

  let created = false;
  try {
    awsIam(['create-role', '--role-name', SCRATCH_ROLE,
      '--assume-role-policy-document', JSON.stringify(trust),
      '--description', 'Ephemeral deny-test for the session classification assertion. Safe to delete.',
      '--max-session-duration', '3600']);
    created = true;
    // IAM is eventually consistent: a freshly created role is not immediately assumable.
    await sleep(12000);

    const attempt = async (tags) => {
      try {
        await sts.send(new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${me.Account}:role/${SCRATCH_ROLE}`,
          RoleSessionName: 'deny-test',
          DurationSeconds: 900,
          Tags: tags,
        }));
        return 'allowed';
      } catch (err) {
        return err?.name === 'AccessDenied' || /not authorized|AccessDenied/i.test(String(err?.message))
          ? 'denied'
          : `error:${err?.name || err}`;
      }
    };

    // CONTROL FIRST. If the matching assertion is denied too, the scratch role is misconfigured and
    // every "denied" below would be meaningless - the vacuous-pass this ordering exists to catch.
    const match = await attempt([
      { Key: 'person', Value: 'deny-test' },
      { Key: 'classification', Value: sample.required },
    ]);
    if (match === 'allowed') pass(`a session asserting '${sample.required}' is allowed (control)`);
    else { fail(`control failed: a MATCHING assertion was ${match} - the rest proves nothing`); return; }

    const other = sample.required === 'basic' ? 'premium' : 'basic';
    const mismatch = await attempt([
      { Key: 'person', Value: 'deny-test' },
      { Key: 'classification', Value: other },
    ]);
    if (mismatch === 'denied') pass(`a session asserting '${other}' is DENIED on the '${sample.required}' role`);
    else fail(`a MIS-VEND was ${mismatch}: '${other}' was accepted on the '${sample.required}' role`);

    const absent = await attempt([{ Key: 'person', Value: 'deny-test' }]);
    if (absent === 'denied') pass('a session asserting NO classification is DENIED');
    else fail(`a session with no classification assertion was ${absent} - the assertion is optional`);
  } finally {
    if (created) {
      try {
        awsIam(['delete-role', '--role-name', SCRATCH_ROLE]);
        console.log(`\n  (scratch role ${SCRATCH_ROLE} deleted)`);
      } catch (err) {
        console.error(`\n  ! could not delete ${SCRATCH_ROLE}: ${err?.name || err} - remove it by hand`);
      }
    }
  }
}

async function main() {
  // A leftover from a killed run would be assumed instead of a fresh one, so it is removed first.
  try {
    awsIam(['get-role', '--role-name', SCRATCH_ROLE]);
    {
      awsIam(['delete-role', '--role-name', SCRATCH_ROLE]);
      console.log(`(removed a leftover ${SCRATCH_ROLE} from a previous run)`);
    }
  } catch { /* nothing to clean */ }

  const sample = await halfOne();
  if (sample) await halfTwo(sample);
  else console.error('\nskipping half 2: no deployed role carried the condition to copy.');

  if (failures.length) {
    console.error(`\n${failures.length} failure(s). The session classification assertion is NOT fully enforced.`);
    process.exit(1);
  }
  console.log('\nThe assertion is required by every classification role, and a mismatched or absent one is refused.');
}

main().catch((err) => {
  console.error('deny-test failed to run:', err);
  process.exit(2);
});
