/**
 * Deploy-context completeness (companion to `deploy.config.example.json`).
 *
 * `deploy-config-example.test.ts` proves the EXAMPLE documents every flag the app reads. That is only
 * half the protection: it says nothing about the deployer's actual `deploy.config.json`, which is
 * gitignored and therefore drifts on its own.
 *
 * That gap is not theoretical. This instance's config was missing `appUrl` while the example
 * documented it correctly. `deploy.mjs` loaded the file, forwarded 13 flags, reported success - and
 * the diff showed every CORS origin about to be rewritten from the live CloudFront URL to
 * `http://localhost:5173`, across eight stacks. An absent flag reads as "off", and for the CORS,
 * admin-IAM, persona and drift flags "off" DELETES something that exists.
 *
 * So a key documented in the example must be PRESENT in the real config, even if empty. The example's
 * own convention makes that cheap: an empty value is skipped when building context args, so `""` is
 * the explicit, reviewable way to say "take the default". Absent means the deployer never saw it.
 */

/** A comment key in either file (`deploy.mjs` skips these when building context args). */
const isComment = (k: string): boolean => k.startsWith('_');

/**
 * Flags whose ABSENCE removes something that already exists, rather than selecting a harmless default.
 *
 * Most context flags are genuinely optional - this deployment legitimately omits 46 of the 60
 * documented keys and wants their defaults. Failing a deploy on all of them would be unusable, and an
 * unusable guard gets bypassed on every run, which is worse than no guard: it trains the operator to
 * pass the escape hatch reflexively.
 *
 * These are different. Each gates a resource or grant that is already provisioned, so "absent" is not
 * "default", it is "delete":
 *
 *  - `appUrl` / `adminAppUrl`   the CORS allowlist on every API. Absent resets it to localhost, which
 *                               takes the live app offline. This is the one that was missing.
 *  - `capabilities`             the declared capability list. Every stack outside the required core
 *                               exists because a capability is named here, so an absent list
 *                               deploys the core alone and removes every other stack.
 *  - `issuers`                  the trusted-issuer registry. Absent trusts this deployment's own pool
 *                               alone, so every other issuer's people are refused at their next request.
 *  - `connectors`               the connector registry. Absent with the connectors capability declared,
 *                               the synth is refused; with it removed, every connector's event
 *                               rule and grants table goes.
 *  - `enableLiveDrift`          unwires live drift and the Aurora retrieval path.
 *  - `analyticsMode`            selects which archive the Archive stack is; flipping it collides with the first mode's retained resources.
 *  - `imageGenKeysSecretArn`    the image-gen provider secret grant.
 *
 * Add to this list when a flag starts gating an existing resource - not when one is merely important.
 */
export const DESTRUCTIVE_IF_ABSENT: readonly string[] = [
  'appUrl',
  'adminAppUrl',
  'capabilities',
  'issuers',
  'connectors',
  'enableLiveDrift',
  'analyticsMode',
  'imageGenKeysSecretArn',
];

/**
 * Retired context keys the app refuses, each with what replaced it.
 *
 * Removing a flag silently is the dangerous direction: a deployer who still passes it believes the
 * old switch works, and nothing tells them otherwise. So a retired key that arrives with any value
 * fails the synth (`assertNoRetiredContext`, called from `bin/backend.ts`) with a message naming its
 * replacement, and `deploy.mjs` names it the same way when it sits in `deploy.config.json`.
 *
 * Read through a loop over this map rather than one literal context read per key, deliberately: the
 * example file documents flags the app READS, and a refused key is not one of them.
 */
export const RETIRED_CONTEXT_KEYS: Readonly<Record<string, string>> = {
  enableBattle:
    'enableBattle is retired. The Battle stack exists when the deployment declares the battle capability: '
    + 'add "battle" (and "experiments", which it requires) to capabilities in deploy.config.json. '
    + 'Remove enableBattle from your context.',
  enableAdminApp:
    'enableAdminApp is retired. The admin console exists when the deployment declares the admin capability: '
    + 'add "admin" to capabilities in deploy.config.json. Remove enableAdminApp from your context.',
  enableAdminNotificationChannel:
    'enableAdminNotificationChannel is retired. The admin notification channel is part of the admin '
    + 'capability: add "admin" to capabilities in deploy.config.json. Remove enableAdminNotificationChannel '
    + 'from your context.',
  enableMeetings:
    'enableMeetings is retired. Meetings is the meetings capability, declared in capabilities in '
    + 'deploy.config.json once its stack is built (lib/config/capabilities.ts says whether it is). '
    + 'Remove enableMeetings from your context.',
  externalConsentDefault:
    'externalConsentDefault is retired. Whether an assistant may send turns to a provider outside AWS is its '
    + 'classification\'s model selection: a classification that selects an external model (models.selected in '
    + 'profiles, deploy.config.json) is granted its key, and one that does not is not. '
    + 'Remove externalConsentDefault from your context.',
  federatedUserPoolId:
    'federatedUserPoolId is retired. A second identity provider is an entry in the trusted-issuer registry, '
    + '"issuers" in deploy.config.json (lib/config/issuers.ts): a host app\'s Cognito pool is '
    + '{ "kind": "cognito-pool", "pool": "<pool id>", "clearance": { "oneChannel": "<classification>", "classifications": '
    + '["<classification>"] } }, served by the same exchange and conversation routes as everyone else. '
    + 'Remove federatedUserPoolId from your context.',
  assistantTier:
    'assistantTier is retired. The classification a host\'s context conversations are created at is the one '
    + 'its issuer declares, clearance.oneChannel on that issuer\'s entry in "issuers" in deploy.config.json. '
    + 'Remove assistantTier from your context.',
  notifyUserPoolId:
    'notifyUserPoolId is retired. The email bridge resolves recipients in this deployment\'s own pool and the '
    + 'other pools the trusted-issuer registry ("issuers" in deploy.config.json) declares, and is on when the '
    + 'deployment declares the notifications capability. Remove notifyUserPoolId from your context.',
  notifyAdditionalUserPoolIds:
    'notifyAdditionalUserPoolIds is retired. Every cognito-pool entry in the trusted-issuer registry ("issuers" '
    + 'in deploy.config.json) is a pool recipients are resolved in. Remove notifyAdditionalUserPoolIds from your context.',
  adminGroupNames:
    'adminGroupNames is retired. The group that marks an admin is adminGroups on the "deployment" entry of the '
    + 'trusted-issuer registry ("issuers" in deploy.config.json), which also declares admin: true. '
    + 'Remove adminGroupNames from your context.',
  identityProvider:
    'identityProvider is retired. Which identity provider governs end users is derived from the trusted-issuer '
    + 'registry ("issuers" in deploy.config.json): cognito, unless a cognito-federated entry names the provider '
    + 'that federates into this pool. Remove identityProvider from your context.',
  isProduction:
    'isProduction is retired. Production is one value, environment in deploy.config.json: "production" '
    + 'retains every table, the message stream and the Aurora cluster at teardown, and "dev" destroys them '
    + '(lib/config/environment.ts). Remove isProduction from your context.',
  hostAdminPoolId:
    'hostAdminPoolId is retired. Every admin route is AWS_IAM-authorized, so no admin authorizer reads a '
    + "host pool; a host identity provider federates into the deployment's own pool instead "
    + '(ADMIN-INTEGRATION-GUIDE, Approach 1). Remove hostAdminPoolId from your context.',
  basicModelKey:
    'basicModelKey is retired. A classification declares the models it selects from the instance\'s catalog and its '
    + 'default, models: { selected: [...], default: ... } on its entry in profiles (deploy.config.json, '
    + 'lib/config/profiles.ts); the shipped catalog\'s classifications declare theirs. Remove basicModelKey from your context.',
  standardModelKey:
    'standardModelKey is retired. A classification declares the models it selects from the instance\'s catalog and its '
    + 'default, models: { selected: [...], default: ... } on its entry in profiles (deploy.config.json, '
    + 'lib/config/profiles.ts); the shipped catalog\'s classifications declare theirs. Remove standardModelKey from your context.',
  premiumModelKey:
    'premiumModelKey is retired. A classification declares the models it selects from the instance\'s catalog and its '
    + 'default, models: { selected: [...], default: ... } on its entry in profiles (deploy.config.json, '
    + 'lib/config/profiles.ts); the shipped catalog\'s classifications declare theirs. Remove premiumModelKey from your context.',
  guestModelKey:
    'guestModelKey is retired. A classification declares the models it selects from the instance\'s catalog and its '
    + 'default, models: { selected: [...], default: ... } on its entry in profiles (deploy.config.json, '
    + 'lib/config/profiles.ts); the shipped catalog\'s classifications declare theirs. Remove guestModelKey from your context.',
  customerModelKey:
    'customerModelKey is retired. A classification declares the models it selects from the instance\'s catalog and its '
    + 'default, models: { selected: [...], default: ... } on its entry in profiles (deploy.config.json, '
    + 'lib/config/profiles.ts); the shipped catalog\'s classifications declare theirs. Remove customerModelKey from your context.',
  cnBedrockChatModel:
    'cnBedrockChatModel is retired. Context routing sends a turn to the catalog\'s deepseek_v3, which the classification '
    + 'selects (models.selected in profiles); a model outside the catalog is not allowed. Remove cnBedrockChatModel from your context.',
  cnBedrockReasoningModel:
    'cnBedrockReasoningModel is retired. Context routing sends a reasoning intent to the catalog\'s deepseek_r1, which the '
    + 'classification selects (models.selected in profiles). Remove cnBedrockReasoningModel from your context.',
  deepseekModel:
    'deepseekModel is retired. The external DeepSeek adapter\'s model is its catalog entry, deepseek_api '
    + '(lib/config/model-catalog.ts), which a classification selects. Remove deepseekModel from your context.',
  additionalRoles:
    'additionalRoles is retired. A role the deployment declares is deployed: name its assistant in profiles in '
    + 'deploy.config.json beside its classification (["basic", "standard", "premium", "ops-premium"] deploys the premium '
    + 'ops assistant), or run npm run add-assistant-role, which adds that name and deploys the classification\'s stack. '
    + 'Remove additionalRoles from your context.',
  membershipAuditAlertChannelArn:
    'membershipAuditAlertChannelArn is retired. Every platform alert, the membership audit findings included, is an ae.alert '
    + 'event on the default EventBridge bus, and the AdminServices stack of the admin capability posts it into its own '
    + 'admin notification channel. Declare "admin" in capabilities in deploy.config.json to receive alerts there. '
    + 'Remove membershipAuditAlertChannelArn from your context.',
};

/**
 * One error per retired key that is present in the context, with ANY value (an empty string included:
 * passing the key at all says the deployer expects it to do something). Empty when none are present.
 */
export function retiredContextKeyErrors(read: (key: string) => unknown): string[] {
  return Object.entries(RETIRED_CONTEXT_KEYS)
    .filter(([key]) => read(key) !== undefined)
    .map(([, message]) => message);
}

/**
 * The synth-time refusal `bin/backend.ts` applies: throws one error naming every retired key present in
 * the context, and returns when none is. A function rather than inline code in the entry point, so the
 * refusal itself is testable.
 */
export function assertNoRetiredContext(read: (key: string) => unknown): void {
  const errors = retiredContextKeyErrors(read);
  if (errors.length) {
    throw new Error(`Retired cdk context:\n  ${errors.join('\n  ')}`);
  }
}

export interface DeployContextGap {
  /**
   * Documented and absent, AND in the destructive set - the next deploy would remove something.
   * This is the only class that stops a deploy.
   */
  destructive: string[];
  /** Documented but absent and harmless - reported so the flag is discoverable, never fatal. */
  missing: string[];
  /** In the deployer's config but not documented - a typo, or a flag retired from the example. */
  unknown: string[];
}

/**
 * Compare a deployer's config against the documented example.
 *
 * Both directions matter. A MISSING key silently drops a flag on the next deploy. An UNKNOWN key is
 * usually a typo, which is worse than it looks: the deployer believes they set something, and the
 * flag they meant is quietly taking its default.
 */
export function compareDeployContext(
  config: Record<string, unknown>,
  example: Record<string, unknown>,
): DeployContextGap {
  const configKeys = new Set(Object.keys(config).filter((k) => !isComment(k)));
  const exampleKeys = Object.keys(example).filter((k) => !isComment(k));

  const absent = exampleKeys.filter((k) => !configKeys.has(k));
  return {
    destructive: absent.filter((k) => DESTRUCTIVE_IF_ABSENT.includes(k)).sort(),
    missing: absent.filter((k) => !DESTRUCTIVE_IF_ABSENT.includes(k)).sort(),
    unknown: [...configKeys].filter((k) => !exampleKeys.includes(k)).sort(),
  };
}

/**
 * The operator-facing message for a gap, or null when the config is complete.
 *
 * Deliberately names the consequence rather than just the keys: "add appUrl" is not actionable, and
 * the reason a deployer skips a warning is that it reads as pedantry. It is not - the last one would
 * have taken the chat app offline.
 */
export function describeDeployContextGap(gap: DeployContextGap, optOutFlag: string): string | null {
  if (!gap.destructive.length && !gap.unknown.length) return null;
  const parts: string[] = [];
  if (gap.destructive.length) {
    parts.push(
      '✗ backend/deploy.config.json is missing flags whose ABSENCE REMOVES something that\n'
        + '  already exists on this instance:\n'
        + gap.destructive.map((k) => `    ${k}`).join('\n')
        + '\n\n  These do not fall back to a harmless default - an absent flag reads as "off", which\n'
        + '  resets CORS to localhost (taking the live app offline), strips admin IAM/persona grants\n'
        + '  across every admin surface, or unwires live drift. Add each key with its real value; an\n'
        + '  empty value ("") is skipped and means "take the default", so only use it deliberately.',
    );
  }
  const retired = gap.unknown.filter((k) => k in RETIRED_CONTEXT_KEYS);
  const unknown = gap.unknown.filter((k) => !(k in RETIRED_CONTEXT_KEYS));
  if (retired.length) {
    parts.push(
      '! These keys in your deploy.config.json are RETIRED, and passing one with any value fails the synth:\n'
        + retired.map((k) => `    ${k}: ${RETIRED_CONTEXT_KEYS[k]}`).join('\n'),
    );
  }
  if (unknown.length) {
    parts.push(
      '! These keys are in your deploy.config.json but are not documented in the example:\n'
        + unknown.map((k) => `    ${k}`).join('\n')
        + '\n  Most likely a typo - the flag you meant is silently taking its default.',
    );
  }
  parts.push(`  Deliberately partial? Re-run with ${optOutFlag}.`);
  return `\n${parts.join('\n\n')}\n`;
}
