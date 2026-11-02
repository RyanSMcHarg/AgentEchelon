/**
 * What `scripts/teardown.mjs` decides before it deletes anything, as pure functions, so every refusal
 * and every match is tested without an AWS account (`test/teardown-plan.test.ts`).
 *
 * 1. WHOSE INSTANCE. The target comes from the instance the operator names (`AE_INSTANCE_NAME`, or one
 *    of the variables `resolveInstanceName` agrees across), never from a default: a teardown with no
 *    instance set is refused, and the default instance, `agent-echelon` (the dev instance), is refused
 *    without `--instance-is-dev`.
 *
 *    AND WHOSE IT IS NOT. The account's other projects come from `AE_TEARDOWN_PROTECT`. An executing run
 *    with it unset is refused; `none` declares an account that holds only this instance.
 *
 * 2. WHICH STACKS. A stack is this instance's when its name is exactly `<prefix><known name>`, where
 *    the known names are every name `lib/config/stack-names.json` lists, current, test-only and
 *    retired. Exact, not `startsWith`: instance `AeNext` never takes `AeNextC0Messaging`, and the retired
 *    names let the teardown remove an instance deployed with the earlier layout, which the current CDK
 *    app no longer synthesizes.
 *
 * 3. IN WHAT ORDER. A stack whose export another stack imports is deleted after its importers, in
 *    rounds. Stacks in another region (the image guardrails, which publish to this region through SSM)
 *    go in the last round.
 *
 * 4. WHICH RETAINED RESOURCES. What a stack leaves behind (RETAIN tables, buckets, pools, the stream,
 *    the app instance, the KMS key) is this instance's when its `Instance` tag says so, or, untagged,
 *    when its name is one this instance gives it. A tag naming another instance always wins.
 *
 * 5. WHAT IS NEVER DELETED. Only the kinds in PURGEABLE_KINDS are ever deleted. A Secrets Manager
 *    secret is never one of them: the external API keys (Twilio, the image-generation providers, any
 *    third-party key) live in secrets, outlive every teardown, and a redeploy reads them again.
 */
const { pascal, resolveStackPrefix, STACK_NAMES, INSTANCE_VARIABLES, DEFAULT_INSTANCE } = require('./stack-lookup.cjs');
const { appInstanceArnOf, isAssistantArn } = require('./person-arn.cjs');

/** The instance variables `resolveInstanceName` reads; at least one must be set explicitly. */
const INSTANCE_VARS = INSTANCE_VARIABLES;

// DEFAULT_INSTANCE is the dev deployment: tearing it down needs the explicit flag.
const INSTANCE_IS_DEV_FLAG = '--instance-is-dev';

/**
 * The instance to tear down and its stack prefix, or a thrown refusal.
 *
 * Refuses with no instance set, refuses the default instance without `--instance-is-dev`, and refuses a
 * stack-prefix override that is not this instance's own prefix: stacks are matched by the prefix and the
 * SSM root by the instance, and a teardown whose two disagree removes part of each of two instances.
 */
function teardownTarget({ env = {}, argv = [] } = {}) {
  const set = INSTANCE_VARS.filter((v) => String(env[v] || '').trim());
  if (!set.length) {
    throw new Error(
      'No instance is set. A teardown deletes one instance, named explicitly: set AE_INSTANCE_NAME '
        + '(for example AE_INSTANCE_NAME=ae-next). There is no default target.',
    );
  }
  const values = [...new Set(set.map((v) => String(env[v]).trim().replace(/^\//, '')))];
  if (values.length > 1) {
    throw new Error(`${set.map((v) => `${v}=${env[v]}`).join(', ')} name different instances. Set one.`);
  }
  const instance = values[0];
  if (!/^[a-z][a-z0-9-]*$/.test(instance)) {
    throw new Error(`Instance "${instance}" is not an instance name (lowercase letters, digits and dashes).`);
  }
  if (instance === DEFAULT_INSTANCE && !argv.includes(INSTANCE_IS_DEV_FLAG)) {
    throw new Error(
      `"${instance}" is the default instance, the dev deployment. Tearing it down needs the owner's go and `
        + `${INSTANCE_IS_DEV_FLAG} on the command line.`,
    );
  }
  const prefix = resolveStackPrefix({ ...env, AE_INSTANCE_NAME: instance, E2E_INSTANCE_NAME: '', INSTANCE_NAME: '', SSM_ROOT: '' });
  if (prefix !== pascal(instance)) {
    throw new Error(
      `The stack prefix "${prefix}" (AE_STACK_PREFIX / STACK_PREFIX) is not instance "${instance}"'s own prefix `
        + `"${pascal(instance)}". Unset the override: a teardown matches stacks by prefix and the SSM root by instance.`,
    );
  }
  return { instance, prefix, isDefault: instance === DEFAULT_INSTANCE };
}

/** The variable naming the account's other projects, and the value that declares there are none. */
const PROTECT_VAR = 'AE_TEARDOWN_PROTECT';
const PROTECT_NONE = 'none';

const PROTECT_GUIDANCE = `Set ${PROTECT_VAR} to the account's other projects, as comma-separated regular expressions `
  + `matched case-insensitively (for example ${PROTECT_VAR}=billing,crm-?app), or to "${PROTECT_NONE}" when the `
  + 'account holds only this instance.';

/**
 * The other-project denylist, or a thrown refusal. Every target is checked against it and one match aborts
 * the run.
 *
 * FAILS CLOSED FOR AN EXECUTING RUN. With `--confirm` and `AE_TEARDOWN_PROTECT` unset, the teardown is
 * refused before anything is deleted, because an empty denylist protects nothing. `none`, exactly, is the
 * operator's declaration that the account holds only this instance, and yields an empty list. A dry run
 * with the variable unset still plans, and returns a warning to print beside the plan.
 */
function otherProjectsDenylist({ env = {}, confirm = false } = {}) {
  const raw = String(env[PROTECT_VAR] ?? '').trim();
  if (raw === PROTECT_NONE) return { patterns: [], declaredNone: true };
  if (!raw) {
    if (confirm) {
      throw new Error(`${PROTECT_VAR} is not set, so this run has no other-project denylist. Nothing was deleted. ${PROTECT_GUIDANCE}`);
    }
    return { patterns: [], warning: `${PROTECT_VAR} is not set: this plan is checked against no other-project denylist, and --confirm is refused until it is. ${PROTECT_GUIDANCE}` };
  }
  const patterns = raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    try {
      return new RegExp(s, 'i');
    } catch (err) {
      throw new Error(`${PROTECT_VAR} entry "${s}" is not a regular expression (${err.message}). ${PROTECT_GUIDANCE}`);
    }
  });
  return { patterns };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REGION = '[a-z]{2}-[a-z]+-\\d';

/** Every stack name this app gives or has given a stack, after the prefix, as one exact pattern. */
const TEARDOWN_STACK_SUFFIX = new RegExp(
  '^(?:' + [
    ...[...STACK_NAMES.current, ...STACK_NAMES.testOnly, ...STACK_NAMES.retired].map(escapeRe),
    `${escapeRe(STACK_NAMES.perClassification)}[a-z0-9]+(?:-[a-z0-9]+)*`,
    `${escapeRe(STACK_NAMES.perRegion)}${REGION}`,
    ...STACK_NAMES.retiredPerClassification.map((f) => `${escapeRe(f)}[A-Z][a-z0-9]*`),
  ].join('|') + ')$',
);

/** True when `stackName` is exactly `<prefix><a name this app gives or gave a stack>`. */
function isTeardownStack(stackName, prefix) {
  const name = String(stackName || '');
  if (!prefix || !name.startsWith(prefix)) return false;
  return TEARDOWN_STACK_SUFFIX.test(name.slice(prefix.length));
}

/** The regions a teardown lists stacks in: the deploy region and each region a stack is pinned to. */
function teardownRegions(defaultRegion) {
  return [...new Set([defaultRegion, ...STACK_NAMES.crossRegions])];
}

/**
 * This instance's stacks among a listing of `{ name, region }` from every region, and the retired ones
 * among them (an instance still on the earlier layout).
 */
function instanceStacks(listing, prefix) {
  const stacks = (listing || []).filter((s) => isTeardownStack(s.name, prefix));
  const retired = stacks.filter((s) => {
    const rest = s.name.slice(prefix.length);
    return STACK_NAMES.retired.includes(rest) || STACK_NAMES.retiredPerClassification.some((f) => rest.startsWith(f));
  });
  return { stacks, retired };
}

/**
 * Every stack name this instance has or had: each fixed name, current, test-only and retired, under the
 * prefix, plus the per-classification and per-region stacks still standing. A retained resource's
 * generated name starts with one of them.
 */
function knownStackNames(prefix, standing = []) {
  const fixed = [...STACK_NAMES.current, ...STACK_NAMES.testOnly, ...STACK_NAMES.retired].map((n) => `${prefix}${n}`);
  return [...new Set([...fixed, ...standing.filter((n) => isTeardownStack(n, prefix))])];
}

/**
 * The stacks in deletion rounds: a stack goes once no remaining stack imports one of its exports, and
 * every stack outside the default region goes in a round after all of the default region's.
 *
 * `imports` maps an exporting stack's name to the names of the stacks importing from it. An importer
 * outside the teardown (another app, another instance) is a refusal: deleting the exporter would fail,
 * and deleting the importer is not this instance's to do. A cycle is a refusal too.
 */
function deletionRounds(stacks, imports, defaultRegion) {
  const names = new Set(stacks.map((s) => s.name));
  const foreign = [];
  for (const [exporter, importers] of Object.entries(imports || {})) {
    if (!names.has(exporter)) continue;
    for (const importer of importers) if (!names.has(importer)) foreign.push(`${importer} imports from ${exporter}`);
  }
  if (foreign.length) {
    throw new Error(`A stack outside this teardown imports from it, so it cannot be deleted:\n  ${foreign.join('\n  ')}`);
  }
  const order = (group) => {
    const rounds = [];
    let left = group.map((s) => s.name);
    while (left.length) {
      const blocked = new Set();
      for (const exporter of left) {
        const importers = (imports || {})[exporter] || [];
        if (importers.some((i) => left.includes(i) && i !== exporter)) blocked.add(exporter);
      }
      const round = left.filter((n) => !blocked.has(n));
      if (!round.length) throw new Error(`The stacks ${left.join(', ')} import from each other in a cycle; delete them by hand.`);
      rounds.push(round.sort());
      left = left.filter((n) => blocked.has(n));
    }
    return rounds;
  };
  const home = stacks.filter((s) => !s.region || s.region === defaultRegion);
  const away = stacks.filter((s) => s.region && s.region !== defaultRegion);
  const regionOf = new Map(stacks.map((s) => [s.name, s.region || defaultRegion]));
  return [...order(home), ...order(away)].map((round) => round.map((name) => ({ name, region: regionOf.get(name) })));
}

// ── Retained resources ─────────────────────────────────────────────────────────────────────────────

/** The only kinds a teardown deletes. Everything else it finds is reported and left. */
const PURGEABLE_KINDS = ['user-pool', 'bucket', 'table', 'stream', 'app-instance', 'kms-key'];

/**
 * A name that looks like it holds an external API key. Checked on every deletion as a second layer
 * behind PURGEABLE_KINDS, so a key held somewhere other than a secret is still not deleted by a match.
 */
const EXTERNAL_KEY_NAME = /twilio|image-?gen|openai|fal[-_]?key|stability|api-?keys?|third-?party|provider-?keys?/i;

/** Throws unless `item` may be deleted: a purgeable kind, never a secret, never a name holding external keys. */
function assertPurgeable(item) {
  if (!item || item.kind === 'secret' || !PURGEABLE_KINDS.includes(item.kind)) {
    throw new Error(`teardown refuses to delete ${item ? `${item.kind} ${item.name || item.id}` : 'an unnamed resource'}: `
      + 'only user pools, buckets, tables, streams, the app instance and KMS keys are deleted, and never a secret');
  }
  if (EXTERNAL_KEY_NAME.test(`${item.name || ''} ${item.id || ''}`)) {
    throw new Error(`teardown refuses to delete ${item.kind} ${item.name || item.id}: its name looks like it holds external API keys`);
  }
}

/** The fixed names this instance gives the resources a stack leaves behind, per kind. */
function ownName(item, { instance, stackNames }) {
  const name = String(item.name || '');
  const I = escapeRe(instance);
  const generated = (sep, lower) => stackNames.some((s) => name.startsWith(`${lower ? s.toLowerCase() : s}${sep}`));
  switch (item.kind) {
    case 'user-pool':
      return new RegExp(`^${I}-(?:users|staff|test-issuer-[a-z][a-z0-9-]{0,31})$`).test(name);
    case 'bucket':
      return new RegExp(`^${I}-(?:conversation|aurora)-archive-\\d{12}-${REGION}$`).test(name) || generated('-', true);
    case 'table':
      return name === `${instance}-deployment-state` || generated('-', false);
    case 'stream':
      return name === `chime-messaging-${instance}` || name === `chime-messaging-${instance}-aurora`;
    case 'app-instance':
      return name === instance;
    case 'kms-key':
      return (item.aliases || []).includes(`alias/${instance}-archive`);
    default:
      return false;
  }
}

/**
 * Which of the resources found are this instance's to delete, and which are kept with why.
 *
 * `inventory` items are `{ kind, id, name, instanceTag, aliases? }`, where `instanceTag` is the value of
 * the `Instance` tag, `null` when the resource carries none, or undefined when it could not be read.
 * `stackNames` are this instance's stack names, for the names CloudFormation generates from them.
 */
function selectRetained({ inventory, instance, stackNames, keepArchives = false }) {
  const purge = [];
  const kept = [];
  for (const item of inventory || []) {
    const taggedOther = typeof item.instanceTag === 'string' && item.instanceTag !== instance;
    const ours = item.instanceTag === instance || (!taggedOther && ownName(item, { instance, stackNames }));
    if (!ours) continue;
    if (item.kind === 'secret') {
      kept.push({ item, why: 'a secret is never deleted: external API keys (Twilio, image generation, other providers) live in secrets' });
      continue;
    }
    if (!PURGEABLE_KINDS.includes(item.kind)) {
      kept.push({ item, why: `a ${item.kind} is not a kind teardown deletes; remove it by hand if it is not wanted` });
      continue;
    }
    if (EXTERNAL_KEY_NAME.test(`${item.name || ''} ${item.id || ''}`)) {
      kept.push({ item, why: 'its name looks like it holds external API keys' });
      continue;
    }
    if (keepArchives && item.kind === 'bucket' && /archive/i.test(item.name || '')) {
      kept.push({ item, why: '--keep-archives' });
      continue;
    }
    purge.push(item);
  }
  return { purge, kept };
}

/**
 * THE ASSISTANT IDENTITIES A TEARDOWN REMOVES (ADR-048, amended 2026-10-23). Every assistant's `AppInstanceBot`
 * and Amazon Lex bot are the provisioner's, not a stack's, so deleting the stacks does not reach a console-created
 * one at all, and a seed whose removal could not finish leaves its ids on the entry. Read from the directory
 * entries (`<root>/assistant-directory/<id>`, never the `_build` or `_name` locks): each that still records an
 * identity or a Lex bot, unless it is a clean tombstone whose retire already removed both.
 */
function assistantIdentitiesToRemove(directoryParams, ssmRoot) {
  const prefix = `${ssmRoot}/assistant-directory/`;
  const out = [];
  for (const p of directoryParams || []) {
    const name = String(p.Name || '');
    if (!name.startsWith(prefix)) continue;
    const assistant = name.slice(prefix.length);
    if (!assistant || assistant.includes('/')) continue;
    let e;
    try { e = JSON.parse(p.Value || '{}'); } catch { continue; }
    if (e.status === 'retired' && !(e.leftover && e.leftover.length)) continue;
    if (!e.botArn && !e.lexBotId) continue;
    out.push({ assistant, ...(e.botArn ? { botArn: e.botArn } : {}), ...(e.lexBotId ? { lexBotId: e.lexBotId } : {}) });
  }
  return out;
}

/**
 * THE CONSOLE-CREATED ASSISTANTS A TEARDOWN RETIRES BEFORE IT DELETES ANY STACK (ADR-048, amended 2026-10-24). No
 * seed removes one, so the teardown removes each such assistant's identity and Amazon Lex bot first, and its
 * directory entry once both are gone (`removeAssistantResources`); one whose identity or bot remains keeps its
 * entry and is tried again after the stacks. A declared assistant is left to its seed, and a tombstone to the purge.
 */
function consoleAssistantsToRetireFirst(directoryParams, ssmRoot) {
  const prefix = `${ssmRoot}/assistant-directory/`;
  const out = [];
  for (const p of directoryParams || []) {
    const name = String(p.Name || '');
    if (!name.startsWith(prefix)) continue;
    const assistant = name.slice(prefix.length);
    if (!assistant || assistant.includes('/')) continue;
    let e;
    try { e = JSON.parse(p.Value || '{}'); } catch { continue; }
    if (e.origin === 'declared' || !['active', 'provisioning', 'retiring'].includes(e.status)) continue;
    out.push({ assistant, parameter: name, ...(e.botArn ? { botArn: e.botArn } : {}), ...(e.lexBotId ? { lexBotId: e.lexBotId } : {}) });
  }
  return out;
}

/** A CLI failure that says the thing is already gone. */
const ALREADY_GONE = /NotFoundException|ResourceNotFoundException|does not exist/i;

/** Whether the app instance an identity belongs to still lists it; true when that cannot be read. */
function identityStillListed(botArn, aws) {
  const appInstanceArn = isAssistantArn(botArn) ? appInstanceArnOf(botArn) : null;
  if (!appInstanceArn) return true;
  const r = aws(['chime-sdk-identity', 'list-app-instance-bots', '--app-instance-arn', appInstanceArn, '--output', 'json']);
  if (!r || r.status !== 0) return !ALREADY_GONE.test(String(r && r.stderr));
  try {
    return (JSON.parse(r.stdout || '{}').AppInstanceBots || []).some((b) => b.AppInstanceBotArn === botArn);
  } catch {
    return true;
  }
}

/**
 * REMOVE ONE ASSISTANT'S IDENTITY AND AMAZON LEX BOT, AND SAY WHAT IS STILL THERE. `aws(args)` runs the CLI and
 * returns its `{ status, stdout, stderr }`. The identity first: it is what can act, so a Lex bot is never removed
 * from under one that remains. An identity is gone when its delete succeeds, when the delete says it is not found,
 * or when its app instance no longer lists it (a deleted identity answers some calls with Forbidden, not NotFound);
 * a Lex bot when its delete succeeds or says it is not found. Returns what remains, empty when both are gone, so a
 * caller never reports removed an assistant whose identity or bot is still there.
 */
function removeAssistantResources(i, aws) {
  const remaining = [];
  if (i.botArn) {
    const r = aws(['chime-sdk-identity', 'delete-app-instance-bot', '--app-instance-bot-arn', i.botArn]);
    const gone = (r && r.status === 0) || ALREADY_GONE.test(String(r && r.stderr)) || !identityStillListed(i.botArn, aws);
    if (!gone) remaining.push(`identity ${i.botArn}`);
  }
  if (i.lexBotId) {
    if (remaining.length) {
      remaining.push(`Lex bot ${i.lexBotId}`);
    } else {
      const r = aws(['lexv2-models', 'delete-bot', '--bot-id', i.lexBotId, '--skip-resource-in-use-check']);
      if (!(r && r.status === 0) && !ALREADY_GONE.test(String(r && r.stderr))) remaining.push(`Lex bot ${i.lexBotId}`);
    }
  }
  return remaining;
}

/** The kind of a tagged resource, from its ARN. */
function kindOfArn(arn) {
  const [, , service, , , rest = ''] = String(arn).split(':');
  if (service === 's3') return 'bucket';
  if (service === 'cognito-idp' && rest.startsWith('userpool/')) return 'user-pool';
  if (service === 'dynamodb' && rest.startsWith('table/') && !rest.includes('/stream/')) return 'table';
  if (service === 'kinesis' && rest.startsWith('stream/')) return 'stream';
  if (service === 'kms' && rest.startsWith('key/')) return 'kms-key';
  if (service === 'chime' && rest.startsWith('app-instance/')) return 'app-instance';
  if (service === 'secretsmanager') return 'secret';
  return service || 'unknown';
}

module.exports = {
  consoleAssistantsToRetireFirst,
  removeAssistantResources,
  INSTANCE_VARS,
  INSTANCE_IS_DEV_FLAG,
  teardownTarget,
  PROTECT_VAR,
  PROTECT_NONE,
  otherProjectsDenylist,
  TEARDOWN_STACK_SUFFIX,
  isTeardownStack,
  teardownRegions,
  instanceStacks,
  knownStackNames,
  deletionRounds,
  PURGEABLE_KINDS,
  EXTERNAL_KEY_NAME,
  assertPurgeable,
  selectRetained,
  kindOfArn,
  assistantIdentitiesToRemove,
};
