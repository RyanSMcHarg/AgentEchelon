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
 *  - `enableAdminApp`, `adminIamEnforcement`, `enableAdminPersonas`,
 *    `enableAdminNotificationChannel`  the admin console's execute-api teeth and persona grants, which
 *                               cascade to every admin surface rather than one stack.
 *  - `enableLiveDrift`          unwires live drift and the Aurora retrieval path.
 *  - `analyticsMode`            selects WHICH analytics stack exists; flipping it strands the other.
 *  - `imageGenKeysSecretArn`    the image-gen provider secret grant.
 *
 * Add to this list when a flag starts gating an existing resource - not when one is merely important.
 */
export const DESTRUCTIVE_IF_ABSENT: readonly string[] = [
  'appUrl',
  'adminAppUrl',
  'enableAdminApp',
  'adminIamEnforcement',
  'enableAdminPersonas',
  'enableAdminNotificationChannel',
  'enableLiveDrift',
  'analyticsMode',
  'imageGenKeysSecretArn',
];

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
  if (gap.unknown.length) {
    parts.push(
      '! These keys are in your deploy.config.json but are not documented in the example:\n'
        + gap.unknown.map((k) => `    ${k}`).join('\n')
        + '\n  Most likely a typo - the flag you meant is silently taking its default.',
    );
  }
  parts.push(`  Deliberately partial? Re-run with ${optOutFlag}.`);
  return `\n${parts.join('\n\n')}\n`;
}
