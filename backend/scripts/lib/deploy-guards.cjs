/**
 * The decisions `deploy.mjs` and `deploy-frontend.mjs` make before they touch AWS, as pure functions.
 *
 * Both scripts drive a live account, so they cannot run under test. What they decide first can:
 *
 * 1. WHICH FRONTEND STACK EACH PUBLISH TARGETS. The chat and admin consoles are two stacks,
 *    `<prefix>ChatApp` and `<prefix>AdminApp`. Each target is derived from the instance prefix
 *    on its own, and each override reaches only its own target: `deploy.mjs` passes its environment to
 *    `deploy-frontend.mjs`, so an override that reached both would send the `--admin` publish at the
 *    chat stack.
 *
 * 2. WHICH ANALYTICS MODE THIS INSTANCE RUNS. `analyticsMode` is chosen on the first deploy. The
 *    Athena and Aurora analytics stacks create resources with the same fixed names (the conversation
 *    archive bucket, the archive Firehose and its log group, the Glue database, the Athena workgroup,
 *    the archive KMS alias) and both write the app instance's one messaging streaming configuration,
 *    so a deploy that flips the mode on an existing instance collides with the stack it replaces.
 *    Switching is not supported; the check refuses it before anything deploys.
 *
 * 3. WHAT `deploy.mjs` FORWARDS, AND IN WHAT ORDER IT RUNS. The context flags it builds from
 *    `deploy.config.json`, what that context says about the two consoles, the arguments of each
 *    backend pass, and the order of its steps.
 *
 * 4. WHETHER A DEPLOY WOULD ROLL A LIVE STACK BACK, for `deploy.mjs` and `deploy-stack.mjs` alike
 *    (see `rollbackVerdict`).
 */

// The one prefix resolver every operator script uses (tenet D9). `resolveInstancePrefix` is that
// function under the name this module's callers know it by.
const { pascal, resolveStackPrefix: resolveInstancePrefix } = require('./stack-lookup.cjs');

/**
 * Why an override cannot be this instance's stack, or null when it can.
 *
 * The CDK app names both frontend stacks `<prefix>ChatApp` and `<prefix>AdminApp`, so an
 * override outside the prefix names another app's or another instance's stack. A prefix check alone
 * is not enough when one instance's prefix starts another's (`Acme` and `AcmeTwo`), so a name shaped
 * like a frontend stack must be one of this instance's two.
 */
function overrideOutsideInstance(name, prefix) {
  if (!name.startsWith(prefix)) return `does not start with this instance's prefix "${prefix}"`;
  if (/(ChatApp|AdminApp)$/.test(name) && name !== `${prefix}ChatApp` && name !== `${prefix}AdminApp`) {
    return `is shaped like another instance's frontend stack; this instance's are ${prefix}ChatApp and ${prefix}AdminApp`;
  }
  return null;
}

/**
 * The two frontend publish targets, each derived from the prefix independently.
 *
 * `FRONTEND_STACK_NAME` overrides the chat target and `ADMIN_FRONTEND_STACK_NAME` the admin target;
 * neither reaches the other. Throws, naming both stacks, when an override points one target at the
 * other's stack, because publishing one console's bundle over the other's is not recoverable by a
 * rerun: the live console is replaced the moment the sync finishes. Throws too when an override names
 * a stack outside this instance.
 */
function resolveFrontendTargets(env = process.env) {
  const prefix = resolveInstancePrefix(env);
  const chatDefault = `${prefix}ChatApp`;
  const adminDefault = `${prefix}AdminApp`;
  const chatOverride = String(env.FRONTEND_STACK_NAME || '').trim();
  const adminOverride = String(env.ADMIN_FRONTEND_STACK_NAME || '').trim();
  const chat = chatOverride || chatDefault;
  const admin = adminOverride || adminDefault;

  // Compared against the derived admin name, not a suffix: a prefix that itself ends in "Admin"
  // (AE_INSTANCE_NAME=ops-admin, so OpsAdminChatApp) is a legitimate chat stack.
  if (chatOverride && (chat === admin || chat === adminDefault)) {
    throw new Error(
      `FRONTEND_STACK_NAME=${chatOverride} names the ADMIN frontend stack, but it sets the CHAT target.\n`
        + `   Chat target:  ${chatDefault} (derived from prefix "${prefix}")\n`
        + `   Admin target: ${admin}\n`
        + '   Unset FRONTEND_STACK_NAME, or point it at the chat stack. The admin target is set only by\n'
        + '   ADMIN_FRONTEND_STACK_NAME.',
    );
  }
  if (adminOverride && (admin === chat || admin === chatDefault)) {
    throw new Error(
      `ADMIN_FRONTEND_STACK_NAME=${adminOverride} names the CHAT frontend stack, but it sets the ADMIN target.\n`
        + `   Chat target:  ${chat}\n`
        + `   Admin target: ${adminDefault} (derived from prefix "${prefix}")\n`
        + '   Unset ADMIN_FRONTEND_STACK_NAME, or point it at the admin stack.',
    );
  }
  for (const [variable, value, derived] of [
    ['FRONTEND_STACK_NAME', chatOverride, chatDefault],
    ['ADMIN_FRONTEND_STACK_NAME', adminOverride, adminDefault],
  ]) {
    const why = value && overrideOutsideInstance(value, prefix);
    if (why) {
      throw new Error(
        `${variable}=${value} ${why}, so it names a stack outside this instance.\n`
          + `   Chat target:  ${chatDefault} (derived from prefix "${prefix}")\n`
          + `   Admin target: ${adminDefault} (derived from prefix "${prefix}")\n`
          + `   Unset ${variable} (the CDK app names this stack ${derived}), or set AE_INSTANCE_NAME /\n`
          + '   AE_STACK_PREFIX to the instance that stack belongs to.',
      );
    }
  }
  return { prefix, chat, admin };
}

/**
 * Stack statuses left by a create that never succeeded. Such a stack exists but has no outputs, so
 * reading its outputs reports it as the wrong kind of stack, and reading its presence reports a mode
 * or a console that is not running. `cdk deploy` deletes a ROLLBACK_COMPLETE or ROLLBACK_FAILED stack
 * and creates it again, and creates a REVIEW_IN_PROGRESS one (a change set never executed) as new.
 */
const FAILED_CREATE_STATUSES = ['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED', 'REVIEW_IN_PROGRESS'];

function isFailedCreate(stackStatus) {
  return FAILED_CREATE_STATUSES.includes(String(stackStatus || ''));
}

/** What a stack in a failed-create status means, for a message. */
function describeFailedCreate(stackName, stackStatus) {
  return `Stack "${stackName}" is in ${stackStatus}: its create never succeeded, so it has no outputs and `
    + 'is not running anything. `npm run deploy` creates it again (cdk deletes a rolled-back stack first).';
}

/**
 * Whether a frontend stack's outputs are the kind the publish expects, or the error to fail with.
 *
 * The admin stack prefixes its outputs `Admin*` (FrontendStack.outputPrefix) and the chat stack does
 * not, so the outputs say which console a stack hosts regardless of what it is called. A stack name
 * can be overridden; the outputs cannot. A stack whose create failed has no outputs at all, and says so
 * rather than being reported as the wrong kind of stack.
 */
function checkFrontendStackOutputs({ stackName, isAdmin, outputKeys, targets, stackStatus }) {
  if (isFailedCreate(stackStatus)) return describeFailedCreate(stackName, stackStatus);
  const keys = new Set(outputKeys || []);
  const want = isAdmin ? 'AdminDistributionBucketName' : 'DistributionBucketName';
  const other = isAdmin ? 'DistributionBucketName' : 'AdminDistributionBucketName';
  if (keys.has(want) && keys.has(isAdmin ? 'AdminDistributionId' : 'DistributionId')) return null;
  const names = targets
    ? `\n   Chat target:  ${targets.chat}\n   Admin target: ${targets.admin}`
    : '';
  if (keys.has(other)) {
    return `Stack "${stackName}" is the ${isAdmin ? 'CHAT' : 'ADMIN'} frontend stack (it has ${other}, not ${want}), `
      + `so publishing the ${isAdmin ? 'admin console' : 'chat app'} there would replace the other console.`
      + `${names}\n   Check FRONTEND_STACK_NAME / ADMIN_FRONTEND_STACK_NAME.`;
  }
  return `Stack "${stackName}" is missing the ${want} / ${isAdmin ? 'AdminDistributionId' : 'DistributionId'} outputs; `
    + `it is not a ${isAdmin ? 'admin' : 'chat'} frontend stack.${names}`;
}

/**
 * Classify a CloudFormation `DescribeStacks` SDK error. Only a ValidationError saying the stack does
 * not exist proves absence; an expired session, a denied call or a throttle leaves presence unknown,
 * and treating those as absent is how a live instance gets deployed as if it were new.
 */
function classifyDescribeStacksError(err) {
  const name = String(err?.name || err?.Code || '');
  const message = String(err?.message || err || '');
  if (/ValidationError/.test(name) && /does not exist/i.test(message)) return 'absent';
  return 'unknown';
}

/**
 * The value a context key resolves to from a forwarded argument list, or undefined.
 *
 * The LAST occurrence wins, matching how the CDK CLI merges repeated `--context` flags, which is what
 * lets a CLI flag override the persisted config placed before it. Accepts `--context k=v`, `-c k=v`
 * and `--context=k=v`.
 */
function contextValue(args, key) {
  let value;
  const prefix = `${key}=`;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    let pair;
    if (a === '--context' || a === '-c') pair = args[i + 1];
    else if (a.startsWith('--context=')) pair = a.slice('--context='.length);
    if (typeof pair === 'string' && pair.startsWith(prefix)) value = pair.slice(prefix.length);
  }
  return value;
}

/**
 * `backend/deploy.config.json` as an object, for a script that reads the deployment's declared settings
 * without deploying (`provision-test-users.mjs`, `lib/deployment-profiles.mjs`). An absent file is `{}`,
 * because a script that only reads a setting runs fine without one. A file that exists and cannot be
 * parsed throws: reading it as empty would quietly drop every setting it declares.
 */
function readDeployConfig(configPath = require('path').join(__dirname, '..', '..', 'deploy.config.json')) {
  const fs = require('fs');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`${configPath} could not be parsed: ${err.message}`);
  }
}

/**
 * `deploy.config.json` as `--context k=v` flags. `_`-prefixed keys are comments and records (the
 * analytics mode record among them), and an empty value is no flag, so neither reaches the CDK app.
 */
function contextFlagsFromConfig(cfg) {
  const out = [];
  for (const [k, v] of Object.entries(cfg || {})) {
    if (k.startsWith('_') || v === undefined || v === null || v === '') continue;
    // A list of names (`capabilities`) goes as a comma list; anything structured (the `issuers`
    // registry, a list of objects) as base64url JSON behind `json64:`, so no shell (the Windows spawn
    // goes through cmd.exe) can split or unquote it. The app decodes it (`parseIssuersContext`).
    const flat = Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null);
    const value = v !== null && typeof v === 'object' && !flat
      ? `json64:${Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')}`
      : v;
    out.push('--context', `${k}=${value}`);
  }
  return out;
}

/**
 * The declared capability names in a forwarded `capabilities` value, parsed the way the CDK app parses
 * it (`parseCapabilities` in lib/config/capabilities.ts): a deploy.config.json array arrives as a
 * comma-separated string, and a JSON array string is accepted too. Absent or empty is none.
 */
function declaredCapabilities(forwarded) {
  const raw = String(contextValue(forwarded, 'capabilities') ?? '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((s) => String(s).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * What the forwarded context (deploy.config.json flags, then CLI flags) says about the two consoles.
 *
 * Read with {@link contextValue}, so every flag spelling counts and the last value wins, as in the CDK
 * CLI. The CDK app creates the chat app stack when `chat` is a declared capability and the admin
 * console stack when `admin` is, so each publish runs exactly when its stack exists.
 */
function consoleContext(forwarded) {
  const declared = declaredCapabilities(forwarded);
  return {
    userSetAppUrl: Boolean(contextValue(forwarded, 'appUrl')),
    userSetAdminAppUrl: Boolean(contextValue(forwarded, 'adminAppUrl')),
    userSetWidgetUrl: Boolean(contextValue(forwarded, 'widgetUrl')),
    chatAppEnabled: declared.includes('chat'),
    adminAppEnabled: declared.includes('admin'),
    widgetEnabled: declared.includes('widget'),
    widgetHostEnabled: declaredWidgetHost(forwarded),
  };
}

/**
 * The widget hosting stack (`<prefix>Widget`, the `widget` capability), the third publish target. It
 * takes no override: nothing publishes to a widget stack but this instance's own.
 */
function widgetStackName(prefix) {
  return `${prefix}Widget`;
}

/**
 * Whether a widget stack carries the outputs the publish reads, or the error to fail with. The widget
 * stack prefixes its outputs `Widget*` (the FrontendStack `outputPrefix` convention the two consoles use),
 * so a chat or admin stack is never taken for it.
 */
function checkWidgetStackOutputs({ stackName, outputKeys, stackStatus }) {
  if (isFailedCreate(stackStatus)) return describeFailedCreate(stackName, stackStatus);
  const keys = new Set(outputKeys || []);
  if (keys.has('WidgetDistributionBucketName') && keys.has('WidgetDistributionId')) return null;
  return `Stack "${stackName}" is missing the WidgetDistributionBucketName / WidgetDistributionId outputs; it is not a widget stack.`;
}

/**
 * The `allowedOrigins` value that asks for the sample host page (`WIDGET_HOST_ORIGIN` in
 * lib/config/issuers.ts, which this hand-written CommonJS cannot import before the build).
 */
const WIDGET_HOST_ORIGIN = 'widget-host';

/**
 * Whether the forwarded `issuers` (a JSON array, or `json64:` base64url JSON as contextFlagsFromConfig
 * writes it) lists the sample host page in some entry's `allowedOrigins`, which is when the CDK app creates
 * the `WidgetHost` stack and the deploy publishes the page. Unparseable is no: synth refuses it anyway.
 */
function declaredWidgetHost(forwarded) {
  let raw = String(contextValue(forwarded, 'issuers') ?? '').trim();
  if (!raw) return false;
  try {
    if (raw.startsWith('json64:')) raw = Buffer.from(raw.slice('json64:'.length), 'base64url').toString('utf8');
    const entries = JSON.parse(raw);
    return Array.isArray(entries)
      && entries.some((e) => Array.isArray(e?.allowedOrigins) && e.allowedOrigins.includes(WIDGET_HOST_ORIGIN));
  } catch {
    return false;
  }
}

/** The sample host page's stack (`<prefix>WidgetHost`, lib/stacks/widget-host-stack.ts). No override. */
function widgetHostStackName(prefix) {
  return `${prefix}WidgetHost`;
}

/** Whether a stack carries the outputs the sample host page's publish reads, or the error to fail with. */
function checkWidgetHostStackOutputs({ stackName, outputKeys, stackStatus }) {
  if (isFailedCreate(stackStatus)) return describeFailedCreate(stackName, stackStatus);
  const keys = new Set(outputKeys || []);
  if (keys.has('WidgetHostBucketName') && keys.has('WidgetHostDistributionId')) return null;
  return `Stack "${stackName}" is missing the WidgetHostBucketName / WidgetHostDistributionId outputs; it is not the sample host page's stack.`;
}

/** The `cdk deploy --all` arguments for a backend pass, with the origins resolved for it. */
function backendDeployArgs(forwarded, { appUrl, adminAppUrl, widgetUrl } = {}) {
  return [
    'cdk', 'deploy', '--all', '--require-approval', 'never', ...forwarded,
    ...(appUrl ? ['--context', `appUrl=${appUrl}`] : []),
    ...(adminAppUrl ? ['--context', `adminAppUrl=${adminAppUrl}`] : []),
    ...(widgetUrl ? ['--context', `widgetUrl=${widgetUrl}`] : []),
  ];
}

/**
 * The origins for the extra CORS pass, or null when it does not run.
 *
 * It runs only when a distribution appeared during this deploy (`late`), and it carries EVERY origin,
 * the ones resolved before pass 1 included: a pass that dropped one would reset that console's CORS
 * allowlist to its fallback on a live instance, or drop the widget frame's origin from `PersonApi`.
 */
function corsPassOrigins({ pre = {}, late = {} }) {
  if (!late.chat && !late.admin && !late.widget) return null;
  return {
    appUrl: pre.chat || late.chat || undefined,
    adminAppUrl: pre.admin || late.admin || undefined,
    widgetUrl: pre.widget || late.widget || undefined,
  };
}

/**
 * The order `deploy.mjs` runs its steps in. `main()` walks this list, so the order is data a test can
 * read rather than a property of the source text:
 *
 *  - both analytics mode checks run before the first `cdk deploy` (the recorded-mode check before the
 *    `cdk list` safety gate, since it needs no AWS call);
 *  - an imported VPC without endpoints is checked for its routes before anything deploys;
 *  - the origins are resolved before the first backend pass, so CORS is right in that pass;
 *  - the mode is recorded only after the first backend pass succeeds;
 *  - a configuration that drops a classification an assistant created in the console is active in is refused
 *    before the first backend pass (a classification's seed never fails its stack's delete).
 */
const DEPLOY_STEPS = [
  'build',
  'resolveContext',
  'assertAnalyticsModeRecord',
  'assertOnlyOurStacks',
  'assertAnalyticsModeMatchesDeployment',
  'assertImportedVpcEgress',
  'resolveOrigins',
  'assertNoRollback',
  'assertNoOrphanedConsoleAssistants',
  'deployBackend',
  'recordAnalyticsMode',
  'recordDeployedCommits',
  'syncContext',
  'genFrontendEnv',
  'publishChat',
  'publishAdmin',
  'publishWidget',
  'publishWidgetHost',
  'corsPass',
  'summary',
];

const ANALYTICS_MODES = ['athena', 'aurora'];

/**
 * The `deploy.config.json` key that records the mode chosen on the first deploy. `_`-prefixed, so
 * deploy.mjs never forwards it as context and the completeness check ignores it.
 */
const ANALYTICS_MODE_RECORD_KEY = '_analyticsModeChosenAtFirstDeploy';

/** The one archive stack this instance holds, in either analytics mode (`bin/backend.ts`). */
function archiveStackName(prefix) {
  return `${prefix}Archive`;
}

/**
 * The mode a deployed instance runs, from its Archive stack and the `AnalyticsMode` output that stack
 * carries in both modes.
 *
 * Returns 'athena', 'aurora', 'none' (a first deploy, or a create that never succeeded, which runs
 * nothing and has no outputs) or 'unknown' (a lookup could not be made, or the stack carries no
 * readable mode, so nothing can be concluded). `presence` is 'present', 'absent', 'unknown' or
 * 'failed-create'; `mode` is the stack's `AnalyticsMode` output.
 */
function deployedAnalyticsMode({ presence, mode }) {
  if (presence === 'unknown') return 'unknown';
  if (presence === 'absent' || presence === 'failed-create') return 'none';
  return ANALYTICS_MODES.includes(mode) ? mode : 'unknown';
}

const TEARDOWN_POINTER = 'docs/guides/admin/AURORA-MODE-GUIDE.md#switching-modes';

/**
 * Whether a deploy may proceed with the requested analytics mode, or the message to refuse it with.
 *
 * `requested` is the raw context value (undefined means the CDK default, athena). `recorded` is the
 * mode `deploy.config.json` recorded on the first deploy, if any. `deployed` is the result of
 * {@link deployedAnalyticsMode}, or undefined when AWS has not been asked yet, so the same function
 * serves the check that runs before any AWS call and the one that runs after.
 *
 * The verdict carries a `warning` when the recorded value is not a mode: it cannot lock anything, and
 * saying nothing about it would leave the deployer believing it does.
 */
function checkAnalyticsModeLock(input) {
  const verdict = analyticsModeVerdict(input);
  const { recorded } = input;
  if (recorded !== undefined && recorded !== null && !ANALYTICS_MODES.includes(recorded)) {
    verdict.warning = `! ${ANALYTICS_MODE_RECORD_KEY}=${JSON.stringify(recorded)} in deploy.config.json is not a mode `
      + '("athena" or "aurora"), so it locks nothing; only the stack check applies. Set it to the mode this\n'
      + '  instance was first deployed with, or delete it to have the next successful deploy record it.';
  }
  return verdict;
}

function analyticsModeVerdict({ requested, recorded, deployed, prefix }) {
  const raw = requested === undefined || requested === '' ? 'athena' : String(requested);
  if (!ANALYTICS_MODES.includes(raw)) {
    return {
      ok: false,
      message: `analyticsMode=${raw} is not a mode. Use "athena" or "aurora" (lower case); the CDK app reads any other value as athena.`,
    };
  }
  const why = '  The analytics mode is chosen on the first deploy. Switching an existing deployment between\n'
    + '  athena and aurora is not supported: both archive modes create the same fixed-name resources\n'
    + '  (the conversation archive bucket, the archive Firehose, the Glue database, the Athena workgroup,\n'
    + '  the archive KMS alias), and the archive bucket is retained when its stack lets it go, so the\n'
    + '  other mode\'s create collides with what the first one left.\n'
    + `  To change modes, tear the instance down and deploy fresh; see ${TEARDOWN_POINTER}.`;

  if (recorded && ANALYTICS_MODES.includes(recorded) && recorded !== raw) {
    return {
      ok: false,
      message: `✗ This instance was first deployed with analyticsMode=${recorded} (recorded as `
        + `${ANALYTICS_MODE_RECORD_KEY} in deploy.config.json); this deploy asks for analyticsMode=${raw}.\n`
        + `${why}\n`
        + `  Keep the mode: set "analyticsMode": "${recorded}" in deploy.config.json and drop any -c analyticsMode flag.\n`
        + `  After a teardown, delete ${ANALYTICS_MODE_RECORD_KEY} from deploy.config.json before the fresh deploy.`,
    };
  }
  const name = archiveStackName(prefix || '');
  if (deployed === undefined || deployed === 'none') return { ok: true };

  if (deployed === 'unknown') {
    return {
      ok: false,
      message: `✗ Could not tell which analytics mode ${name} runs (the stack could not be read, or it carries\n`
        + '  no AnalyticsMode output), so the analytics mode of this instance is unknown. Refusing to deploy\n'
        + '  rather than risk flipping it. Fix the AWS session (credentials, region, permissions to describe\n'
        + '  stacks) and rerun.',
    };
  }
  if (deployed !== raw) {
    return {
      ok: false,
      message: `✗ This instance runs analyticsMode=${deployed} (${name} says so in its AnalyticsMode output); this deploy asks for analyticsMode=${raw}.\n`
        + `${why}\n`
        + `  Keep the mode: set "analyticsMode": "${deployed}" in deploy.config.json and drop any -c analyticsMode flag.`,
    };
  }
  return { ok: true };
}

/**
 * `deploy.config.json` text with the chosen mode recorded, or null when nothing needs writing.
 *
 * A textual insert after the opening brace rather than a JSON round-trip, so the deployer's own file
 * keeps its order, spacing and blank lines, and the inserted line uses the file's own line ending and
 * the indent of its first key. Writes once: an existing record is never replaced, because replacing it
 * is exactly the switch the record exists to refuse.
 */
function recordAnalyticsModeText(text, mode) {
  if (!ANALYTICS_MODES.includes(mode)) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Object.prototype.hasOwnProperty.call(parsed, ANALYTICS_MODE_RECORD_KEY)) return null;
  const at = text.indexOf('{');
  const rest = text.slice(at + 1);
  const empty = Object.keys(parsed).length === 0;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = (/\n([ \t]*)"/.exec(rest) || [null, '  '])[1];
  const line = `${eol}${indent}"${ANALYTICS_MODE_RECORD_KEY}": "${mode}"${empty ? eol : ','}`;
  const next = text.slice(0, at + 1) + line + (empty ? rest.replace(/^\s*/, '') : rest);
  JSON.parse(next); // never write a file this function made unparseable
  return next;
}

/**
 * 4. WHETHER A DEPLOY WOULD ROLL A LIVE STACK BACK.
 *
 * A stack deployed from a checkout that does not contain what is live removes the live commits it
 * lacks, and CloudFormation reports that as a successful update. Measured 2026-10-14: a single-stack
 * deploy from a feature branch 208 commits behind would have moved every admin experiments route from
 * IAM to a Cognito authorizer, and only an unrelated missing export stopped it.
 *
 * So every deploy that goes through `deploy.mjs` or `deploy-stack.mjs` records the commit it shipped,
 * per stack, in SSM, and refuses to deploy a stack whose recorded commit is not an ancestor of the
 * one being deployed. The record lives outside CloudFormation on purpose: a stack tag or output that
 * changes every commit would put a change into every `cdk diff`, including the reviewed diff of a
 * role addition, which has to show exactly what is being approved.
 *
 * NO RECORD IS ALLOWED, AND SAYS SO. A stack deployed before this check existed has none; the first
 * guarded deploy writes it. That is the one way past the check without an override, and it closes
 * itself on use.
 */
const DEPLOYED_COMMIT_DIR = 'deployed-commit';

function deployedCommitParamName(instanceName, stackName) {
  return `/${instanceName}/${DEPLOYED_COMMIT_DIR}/${stackName}`;
}

/** The value written for a stack after it deploys. */
function deployedCommitRecord({ commit, dirty, by, at = new Date().toISOString() }) {
  return JSON.stringify({ commit, dirty: Boolean(dirty), by, at });
}

/** A stored record, or null when there is none or it cannot be read as one. */
function parseDeployedCommitRecord(value) {
  if (!value) return null;
  try {
    const r = JSON.parse(value);
    return r && typeof r.commit === 'string' && /^[0-9a-f]{40}$/.test(r.commit) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Whether a stack may deploy from `head`. Pure: the caller does the git and SSM reads.
 *
 * @param {object} input
 * @param {string} input.stackName
 * @param {string} input.head            the full commit being deployed
 * @param {boolean} input.dirty          the checkout has uncommitted changes
 * @param {object|null} input.deployed   the stack's parsed record, or null
 * @param {boolean} input.knownLocally   the recorded commit exists in this clone
 * @param {boolean} input.isAncestor     the recorded commit is an ancestor of `head`
 * @param {boolean} [input.allowRollback]
 * @param {boolean} [input.allowDirty]
 * @returns {{ ok: boolean, reason?: string, note?: string }}
 */
function rollbackVerdict(input) {
  const { stackName, head, dirty, deployed, knownLocally, isAncestor, allowRollback, allowDirty } = input;
  if (dirty && !allowDirty) {
    return {
      ok: false,
      reason: `${stackName}: the checkout has uncommitted changes. They would ship, and no commit could say what is live. `
        + 'Commit them, or pass --allow-dirty to deploy them anyway (recorded as dirty).',
    };
  }
  if (!deployed) {
    return { ok: true, note: `${stackName}: no deployed-commit record yet; this deploy writes the first one.` };
  }
  const short = (c) => c.slice(0, 8);
  const wasDirty = deployed.dirty ? ` (it was deployed with uncommitted changes, by ${deployed.by || 'unknown'})` : '';
  if (deployed.commit === head) {
    return { ok: true, note: `${stackName}: redeploying ${short(head)}, the commit already live${wasDirty}.` };
  }
  if (!knownLocally) {
    if (allowRollback) return { ok: true, note: `${stackName}: --allow-rollback over a live commit this clone does not have (${short(deployed.commit)}).` };
    return {
      ok: false,
      reason: `${stackName}: the live commit ${short(deployed.commit)} is not in this clone, so whether this deploy would remove it cannot be checked. `
        + 'Fetch (git fetch private), check out a branch that contains it, and retry.',
    };
  }
  if (isAncestor) {
    return { ok: true, note: `${stackName}: ${short(deployed.commit)} -> ${short(head)}, forward${wasDirty}.` };
  }
  if (allowRollback) {
    return { ok: true, note: `${stackName}: --allow-rollback from ${short(deployed.commit)} to ${short(head)}, which does not contain it.` };
  }
  return {
    ok: false,
    reason: `${stackName}: the live commit ${short(deployed.commit)} is not an ancestor of ${short(head)}. Deploying would remove live commits `
      + `this checkout does not have${wasDirty}. Deploy from a checkout that contains ${short(deployed.commit)} (rebase onto private/main), `
      + 'or pass --allow-rollback if removing them is the intent.',
  };
}

module.exports = {
  DEPLOYED_COMMIT_DIR,
  deployedCommitParamName,
  deployedCommitRecord,
  parseDeployedCommitRecord,
  rollbackVerdict,
  pascal,
  resolveInstancePrefix,
  resolveFrontendTargets,
  FAILED_CREATE_STATUSES,
  isFailedCreate,
  describeFailedCreate,
  checkFrontendStackOutputs,
  classifyDescribeStacksError,
  contextValue,
  contextFlagsFromConfig,
  readDeployConfig,
  declaredCapabilities,
  consoleContext,
  widgetStackName,
  checkWidgetStackOutputs,
  WIDGET_HOST_ORIGIN,
  declaredWidgetHost,
  widgetHostStackName,
  checkWidgetHostStackOutputs,
  backendDeployArgs,
  corsPassOrigins,
  DEPLOY_STEPS,
  ANALYTICS_MODES,
  ANALYTICS_MODE_RECORD_KEY,
  archiveStackName,
  deployedAnalyticsMode,
  checkAnalyticsModeLock,
  recordAnalyticsModeText,
};
