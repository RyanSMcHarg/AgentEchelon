#!/usr/bin/env node
/**
 * Backfill the `classification` tag on existing AppInstanceUsers.
 *
 * THE GAP THIS CLOSES. The credential exchange stamps a person's clearance onto their
 * identity on every vend, including the conflict branch that runs for an already-provisioned user.
 * That is a self-healing path, and it heals only when the person next signs in. Every identity
 * created before identity tagging shipped therefore stays untagged until its owner happens to come
 * back - which for a seeded demo user, a departed employee, or anyone on holiday is "indefinitely".
 *
 * The platform's stated mechanism is that every classification-bearing principal carries its
 * classification as a tag. "Eventually, per person, on their next sign-in" is a different claim, and
 * a weaker one. This makes it true now.
 *
 * NOT AN ENFORCEMENT CHANGE. Access is decided by the classification-bound role the exchange vends,
 * not by this tag; the tag is what makes the same fact READABLE on the principal, so an auditor
 * comparing a member against a channel compares two values of one kind. A missing tag costs a lookup,
 * never an admission.
 *
 * WHY IT RUNS OUT HERE. It needs Cognito (the authoritative groups) and Chime SDK Identity (the tag),
 * neither of which the Aurora VPC can reach. Same reasoning as
 * `backfill-channel-classifications.mjs`, which does the channel half.
 *
 * CLEARANCE IS RESOLVED, NEVER GUESSED. The clearance comes from `profiles.clearanceForGroups` over the
 * user's real Cognito groups - the SAME function the exchange uses to choose the role it vends - so
 * the tag and the role cannot disagree. A user whose groups map to nothing is left ALONE rather than
 * stamped with the floor: an untagged identity is one a reader treats as unclassified, which is
 * recoverable; a wrong tag reads as authority the person does not hold.
 *
 * USAGE
 *   npm run build                                              # this imports COMPILED lib/
 *   node backend/scripts/backfill-identity-classifications.mjs [--dry-run] [--only=<sub|email>]
 *
 * Reads the deployment context from `backend/deploy.config.json`, like the other ops scripts.
 */

import {
  ChimeSDKIdentityClient,
  ListAppInstanceUsersCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
// COMPILED output, not the TypeScript source: `lib/profile-registry.js` exists only after
// `npm run build`. Imported rather than reimplemented because the group -> clearance mapping is
// deployment config, and a second copy of it here is exactly the drift the registry exists to end.
// The deployment's set, not the shipped catalog: imported first, so the registry below is built from it.
import './lib/deployment-profiles.mjs';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const DRY_RUN = process.argv.includes('--dry-run');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null;

function loadConfig() {
  const p = path.join(REPO_ROOT, 'backend', 'deploy.config.json');
  if (!fs.existsSync(p)) {
    console.error(`✗ ${p} not found. This script needs the deployment context (region).`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const config = loadConfig();
const REGION = config.region || process.env.AWS_REGION || 'us-east-1';
const STACK_PREFIX = createRequire(import.meta.url)('./lib/stack-lookup.cjs').resolveStackPrefix(process.env);
const { personIdFromArn } = createRequire(import.meta.url)('./lib/person-arn.cjs');

const chime = new ChimeSDKIdentityClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

/** One stack output by key, or null. */
async function stackOutput(stackName, predicate) {
  try {
    const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const outs = r.Stacks?.[0]?.Outputs || [];
    return outs.find(predicate)?.OutputValue ?? null;
  } catch {
    return null;
  }
}

async function resolveContext() {
  const appInstanceArn = process.env.APP_INSTANCE_ARN
    || config.appInstanceArn
    || await stackOutput(`${STACK_PREFIX}Messaging`, (o) => o.OutputKey === 'AppInstanceArnOutput');
  const userPoolId = process.env.USER_POOL_ID
    || config.userPoolId
    || await stackOutput(`${STACK_PREFIX}Identity`, (o) => /UserPoolId/i.test(o.OutputKey) && !/Client/i.test(o.OutputKey));
  return { appInstanceArn, userPoolId };
}

async function listAllUsers(appInstanceArn) {
  const arns = [];
  let next;
  do {
    const r = await chime.send(new ListAppInstanceUsersCommand({
      AppInstanceArn: appInstanceArn, MaxResults: 50, NextToken: next,
    }));
    for (const u of r.AppInstanceUsers || []) if (u.AppInstanceUserArn) arns.push(u.AppInstanceUserArn);
    next = r.NextToken;
  } while (next);
  // DEDUPED. The listing can repeat an ARN across pages, and tagging one twice is harmless but makes
  // the counts this prints wrong - and the counts are the only evidence the run produces.
  return [...new Set(arns)];
}

function subOf(userArn) {
  return personIdFromArn(userArn) || '';
}

async function classificationTagOf(userArn) {
  try {
    const r = await chime.send(new ListTagsForResourceCommand({ ResourceARN: userArn }));
    return (r.Tags || []).find((t) => t.Key === 'classification')?.Value ?? null;
  } catch {
    return null;
  }
}

async function clearanceOf(userPoolId, sub) {
  try {
    const r = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: sub }));
    const groups = (r.Groups || []).map((g) => g.GroupName).filter(Boolean);
    if (groups.length === 0) return null;
    const clearance = profiles.clearanceForGroups(groups);
    // `clearanceForGroups` fail-closes to the floor when NO group maps, which is right for choosing a
    // role and wrong for writing a durable label: it would stamp "basic" on somebody whose groups this
    // deployment simply does not map. Only a group that actually maps produces a tag here.
    const mapped = groups.some((g) => profiles.groupClearance[g]);
    return mapped ? clearance : null;
  } catch {
    // A federated or deleted principal has no Cognito record. Not an error, and not a classification.
    return null;
  }
}

async function main() {
  const { appInstanceArn, userPoolId } = await resolveContext();
  if (!appInstanceArn || !userPoolId) {
    console.error('✗ could not resolve context. Need APP_INSTANCE_ARN and USER_POOL_ID (env, deploy.config.json, or stack outputs).');
    process.exit(1);
  }
  console.log(`App instance: ${appInstanceArn}`);
  console.log(`User pool:    ${userPoolId}${DRY_RUN ? '   [--dry-run]' : ''}\n`);

  const arns = await listAllUsers(appInstanceArn);
  console.log(`${arns.length} app-instance user(s)\n`);

  let tagged = 0; let already = 0; let skipped = 0; let failed = 0;
  for (const arn of arns) {
    const sub = subOf(arn);
    if (ONLY && sub !== ONLY) continue;

    const existing = await classificationTagOf(arn);
    if (existing) { already += 1; continue; }

    // ── AN ADMIN-PLANE IDENTITY IS ITS OWN PRINCIPAL, WITH ITS OWN CLASSIFICATION ───────────────
    //
    // Two kinds of identity live on the admin plane, and NEITHER is a Cognito user, so resolving by
    // group returns nothing and both were skipped - leaving the principals with the widest reach as
    // the only ones a reader could not classify:
    //
    //   `<personId>-admin`     a console admin's elevated identity, distinct from their chat `<personId>`
    //   `agent-echelon-admin`  the SERVICE app-instance-admin, which moderates without membership
    //
    // The `-admin` suffix covers both. That is stated rather than left to luck: the service admin
    // matching this rule by virtue of its NAME is a coincidence, and a coincidence is not a reason -
    // it is covered because it genuinely belongs to this class, and a future identity that ends in
    // `-admin` without belonging here would need a narrower rule.
    //
    // Each gets the admin plane's own value, matching `ensureAdminIdentity` in the credential
    // exchange. Deliberately NOT a person's clearance: the chat identity's tag says what somebody is
    // cleared for, and these identities are separate precisely because they answer different
    // questions - copying one onto the other blurs the line the split exists to draw.
    const clearance = sub.endsWith('-admin')
      ? profiles.mostRestrictiveValue
      : await clearanceOf(userPoolId, sub);
    if (!clearance) {
      // Left alone on purpose: see the header. An unmapped principal stays unclassified.
      skipped += 1;
      console.log(`  - ${sub.slice(0, 12)}  no mapped clearance; left untagged`);
      continue;
    }

    if (DRY_RUN) {
      tagged += 1;
      console.log(`  ~ ${sub.slice(0, 12)}  would tag '${clearance}'`);
      continue;
    }
    try {
      await chime.send(new TagResourceCommand({
        ResourceARN: arn, Tags: [{ Key: 'classification', Value: clearance }],
      }));
      tagged += 1;
      console.log(`  ✓ ${sub.slice(0, 12)}  tagged '${clearance}'`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${sub.slice(0, 12)}  ${err?.name || err}`);
    }
  }

  console.log(`\n${DRY_RUN ? 'would tag' : 'tagged'} ${tagged}, already tagged ${already}, left untagged ${skipped}, failed ${failed}`);
  // A failure to tag is not a failure to enforce, so this does not exit non-zero on one - but it does
  // say so, because an unclassified principal is the platform's stated mechanism not holding.
  if (failed > 0) console.error('\n✗ some identities could not be tagged; they remain unclassified and readable as such.');
}

main().catch((err) => {
  console.error('✗ backfill failed:', err);
  process.exit(1);
});
