#!/usr/bin/env node
/**
 * Live deny-test: does IAM match a TAG KEY case-insensitively in a principal-vs-resource condition?
 * (SPEC-CONVERSATION-SECURITY section 4d.)
 *
 * Role tags surface as principal tags, and a role tagged `Classification=<value>` (capital C) beside
 * channels and identities tagged `classification=<value>` is the case measured here. The stacks write
 * `classification` only. A condition that
 * compares the two - `aws:ResourceTag/classification` equal to `${aws:PrincipalTag/Classification}` -
 * either enforces something or silently never matches, and which one depends on whether IAM treats
 * the key portion of a tag condition key case-insensitively. Tenet P4: that is settled by a deny that
 * IAM itself decides, not by reading documentation.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * A scratch role trusting the runner, tagged `Classification=basic` (capital C, the shape the stacks
 * write), and two scratch SSM parameters tagged `classification=basic` and `classification=premium`
 * (lowercase, the shape channels carry). The role's policy allows `ssm:GetParameter` only where the
 * parameter's `classification` tag equals the principal's classification tag, and the principal tag is
 * referenced in the OTHER case from the one the role carries. Then the role is really assumed and both
 * parameters really read:
 *
 *   - the basic parameter is readable      -> keys matched across case, and the condition enforces;
 *   - the premium parameter is refused     -> the comparison is on the value, not vacuously true.
 *
 * A third case measures the RESOURCE side: a condition naming `aws:ResourceTag/Classification` (capital C)
 * with a literal value, against parameters tagged `classification`. The stacks now write and condition on
 * `classification` only, so no live condition depends on the answer; it is recorded so that a capital key
 * reintroduced anywhere is known to match or not.
 *
 * Each case runs on its OWN role, each with one statement, so an allow can
 * only come from the statement under test and never from a previous case's policy still propagating.
 *
 * Every scratch resource is deleted afterwards, and a leftover from a killed run is removed first.
 *
 * USAGE
 *   AWS_PROFILE=<profile> node backend/scripts/deny-test-tag-key-case.mjs
 *
 * Exit 0 = measured and the case-crossing condition enforces; 1 = it does not; 2 = setup error.
 */
import { execFileSync } from 'child_process';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ROLE = 'AgentEchelon-DenyTest-TagKeyCase';
const PARAM_PREFIX = '/agent-echelon-deny-test/tag-key-case';
const sts = new STSClient({ region: REGION });

/** One AWS CLI call, argv only (no shell), JSON out. */
function aws(service, args) {
  const out = execFileSync('aws', [service, ...args, '--output', 'json', '--region', REGION], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AWS_REGION: REGION },
    // stderr is captured, not printed: the pre-run cleanup expects most deletes to find nothing.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.trim() ? JSON.parse(out) : {};
}
const quiet = (fn) => { try { fn(); } catch { /* absent */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };

/** One role per case, so a policy from the previous case can never still be the one evaluated. */
const CASES = { Classification: 'Same', classification: 'Crossed', resource: 'Resource' };
const roleFor = (caseKey) => `${ROLE}-${CASES[caseKey]}`;

function cleanup() {
  for (const key of Object.keys(CASES)) {
    quiet(() => aws('iam', ['delete-role-policy', '--role-name', roleFor(key), '--policy-name', 'under-test']));
    quiet(() => aws('iam', ['delete-role', '--role-name', roleFor(key)]));
  }
  for (const v of ['basic', 'premium']) quiet(() => aws('ssm', ['delete-parameter', '--name', `${PARAM_PREFIX}/${v}`]));
}

/** Read one parameter as the scratch role; 'allowed' | 'denied' | 'error:<name>'. */
async function readAs(creds, name) {
  const ssm = new SSMClient({
    region: REGION,
    credentials: { accessKeyId: creds.AccessKeyId, secretAccessKey: creds.SecretAccessKey, sessionToken: creds.SessionToken },
  });
  try {
    await ssm.send(new GetParameterCommand({ Name: name }));
    return 'allowed';
  } catch (err) {
    return /AccessDenied|not authorized/i.test(`${err?.name} ${err?.message}`) ? 'denied' : `error:${err?.name || err}`;
  }
}

/** Put the policy under test, assume the role, read both parameters. Retries while IAM propagates. */
async function runCase(account, principal, caseKey) {
  const role = roleFor(caseKey);
  aws('iam', ['create-role', '--role-name', role,
    '--assume-role-policy-document', JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: principal }, Action: 'sts:AssumeRole' }],
    }),
    // Capital C, the case under measurement.
    '--tags', 'Key=Classification,Value=basic',
    '--description', 'Ephemeral deny-test for tag key case matching. Safe to delete.']);
  const policy = {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Action: 'ssm:GetParameter',
      Resource: `arn:aws:ssm:${REGION}:${account}:parameter${PARAM_PREFIX}/*`,
      Condition: caseKey === 'resource'
        ? { StringEquals: { 'aws:ResourceTag/Classification': 'basic' } }
        : { StringEquals: { 'aws:ResourceTag/classification': `\${aws:PrincipalTag/${caseKey}}` } },
    }],
  };
  aws('iam', ['put-role-policy', '--role-name', role, '--policy-name', 'under-test', '--policy-document', JSON.stringify(policy)]);

  // Propagation: a new role and policy are not evaluated immediately. Retry until the matching read is
  // allowed, bounded (80s), and report what was last seen rather than guessing. A case-sensitive result
  // therefore costs the full bound, which is the price of not mistaking propagation for a deny.
  let last = null;
  for (let i = 0; i < 8; i++) {
    await sleep(10000);
    try {
      const assumed = await sts.send(new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${account}:role/${role}`, RoleSessionName: 'tag-key-case', DurationSeconds: 900,
      }));
      last = {
        basic: await readAs(assumed.Credentials, `${PARAM_PREFIX}/basic`),
        premium: await readAs(assumed.Credentials, `${PARAM_PREFIX}/premium`),
      };
      if (last.basic === 'allowed') return last;
    } catch (err) {
      last = { assume: `error:${err?.name || err}` };
    }
  }
  return last;
}

async function main() {
  cleanup();
  const me = await sts.send(new GetCallerIdentityCommand({}));
  const roleName = String(me.Arn || '').replace(/^.*:assumed-role\/([^/]+)\/.*$/, '$1');
  const principal = aws('iam', ['get-role', '--role-name', roleName])?.Role?.Arn;
  if (!principal) { console.error(`cannot resolve the runner's role from ${me.Arn}`); process.exit(2); }

  try {
    for (const v of ['basic', 'premium']) {
      aws('ssm', ['put-parameter', '--name', `${PARAM_PREFIX}/${v}`, '--type', 'String', '--value', v,
        '--tags', `Key=classification,Value=${v}`]);
    }

    console.log('\n1. CONTROL: the principal tag referenced in the case the role carries (Classification)\n');
    const control = await runCase(me.Account, principal, 'Classification');
    console.log('   observed:', JSON.stringify(control));
    if (control?.basic === 'allowed' && control?.premium === 'denied') {
      pass('same-case condition allows the matching parameter and denies the other');
    } else {
      fail(`control did not behave (${JSON.stringify(control)}) - the case below proves nothing`);
      return;
    }

    console.log('\n2. UNDER TEST: the principal tag referenced in the OTHER case (classification)\n');
    const crossed = await runCase(me.Account, principal, 'classification');
    console.log('   observed:', JSON.stringify(crossed));
    if (crossed?.basic === 'allowed' && crossed?.premium === 'denied') {
      pass('IAM matches the tag key case-insensitively: a Classification role tag satisfies ${aws:PrincipalTag/classification}');
    } else if (crossed?.basic === 'denied' && crossed?.premium === 'denied') {
      fail('IAM matches the tag key case-SENSITIVELY: a principal-vs-resource condition across the two casings never matches');
    } else {
      fail(`inconclusive: ${JSON.stringify(crossed)}`);
    }

    console.log('\n3. RESOURCE SIDE: aws:ResourceTag/Classification against parameters tagged classification\n');
    const resource = await runCase(me.Account, principal, 'resource');
    console.log('   observed:', JSON.stringify(resource));
    if (resource?.basic === 'allowed' && resource?.premium === 'denied') {
      pass('IAM matches a resource tag key case-insensitively too');
    } else if (resource?.basic === 'denied' && resource?.premium === 'denied') {
      // Recorded, not a failure: no condition in the stacks uses the capital key.
      pass('IAM matches a resource tag key case-SENSITIVELY: a capital-C resource condition never matches a lowercase tag');
    } else {
      fail(`inconclusive: ${JSON.stringify(resource)}`);
    }
  } finally {
    cleanup();
    console.log('\n  (scratch role and parameters deleted)');
  }

  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error('deny-test failed to run:', err); cleanup(); process.exit(2); });
