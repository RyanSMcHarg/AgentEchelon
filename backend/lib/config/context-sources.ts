/**
 * Context source catalog (SPEC-CONTEXT-SOURCES-AND-STORES) - the set of context sources a deployment
 * PROVISIONS and a profile may SELECT among by key.
 *
 * Same shape as `guardrail-catalog.ts`, for the same reason: defined as DATA rather than CDK
 * literals, so a deployment offers its own sources without forking the stack. The stack iterates
 * whatever the loader returns; it never names a source.
 *
 * WHERE THE DATA COMES FROM, in precedence order:
 *   1. `context-sources.local.ts`  - GITIGNORED, the deployer's own. Copy the example to start.
 *   2. `context-sources.example.ts` - tracked, the shipped illustration. Used when no local file.
 * A deployer therefore never edits a tracked file, so `git pull` cannot conflict with their
 * customization - the same posture as `deploy.config.json` and `.githooks/privacy-denylist`.
 *
 * The demo's own sources live under `backend/demo/`, never here; `demo-config-boundary.test.ts`
 * enforces that core cannot import them.
 *
 * SECURITY: this file defines SHAPE only. Two invariants live in the stack that consumes it, because
 * they cannot be expressed here: the IAM grant must be scoped to each entry's exact ARN
 * (INV-CTX-CAT-3), and publication and grant must happen in the same construct - a published key
 * without its grant fails at runtime, which is a failure that fails OPEN.
 */

/**
 * How the resolver reads a source. An ARN implies the service, never the access pattern.
 *
 * `lambda-service` is a Lambda the DEPLOYMENT owns which implements a known platform contract - the
 * per-user profile store (`USER_PROFILE_SERVICE_ARN`) is the shipped example.
 *
 * There is deliberately NO `connector` type yet. A vendor connector contributes context ONLY through
 * its own inbound capability (`fetchContext`), which makes it the PROVIDER of a source rather than a
 * parallel concept - but `lib/config/connectors.ts` is still a design-only seam ("nothing here is
 * consumed at runtime yet"), so a `connector` type would advertise a capability that resolves
 * nowhere. It is added when connectors are defined, not before: an unimplemented enum member is the
 * partial-build shape this project is trying to stop.
 *
 * That work also has a boundary to settle first - connectors are declared per CONVERSATION TYPE while
 * context sources are per CLASSIFICATION, which is the isolation boundary, so inbound connector
 * capabilities must be re-scoped before one can back a context source.
 */
export type ContextSourceType = 's3-prefix' | 'dynamodb-table' | 'lambda-service' | 'ssm-parameter';

/**
 * What a resolved value is allowed to influence (INV-CTX-CAT-2).
 *
 * `member` is the default for anything unspecified, and it is the correct default: Amazon Chime SDK
 * channel `Metadata` is MEMBER-WRITABLE (a participant holds `UpdateChannel`, which sets Name and
 * Metadata in one call), so anything sourced from it is attacker-controlled.
 */
export type ContextSourceTrust = 'platform' | 'operator' | 'member';

/**
 * The earliest point a source is reliably readable.
 *
 * `WelcomeIntent` fires on the assistant's channel membership, BEFORE the creator's membership and
 * before channel metadata converge (both eventually consistent). A source whose availability is unmet
 * at a call site is OMITTED, never awaited - awaiting would trade the welcome's one guaranteed
 * property (it always lands, promptly) for data that may never arrive.
 */
export type ContextSourceAvailability = 'always' | 'identity-settled' | 'conversation-settled';

/** One field a source yields. The type language is deliberately small; nesting is not supported. */
export interface ContextSourceField {
  type: 'string' | 'number' | 'boolean' | 'string[]';
  /**
   * Where this field's value comes from WITHIN the source, when the field name alone is not enough.
   *
   * `s3-prefix`: the object key relative to `prefix` (e.g. `_digest.json`). A generic reader cannot
   * guess which object backs which field, and defaulting to `{field}.json` would be a silent
   * convention that breaks the moment a corpus does not follow it. Defaults to `{field}.json`.
   *
   * `dynamodb-table` / `lambda-service`: the attribute name on the returned item, when it differs from
   * the field name. Defaults to the field name.
   *
   * Ignored for `ssm-parameter`, where the parameter value IS the single field.
   */
  from?: string;
  /** Optional fields resolve to '' and DROP their template clause rather than leaving a hole. */
  optional?: boolean;
  /**
   * What this field means, for a human configuring an assistant AND for a model deciding whether to
   * use it. Disambiguate anything readable two ways - this is why `user-profile.role` says "their job
   * role, not their role in this conversation".
   */
  description: string;
}

/** One selectable context source. */
export interface ContextSourceEntry {
  /** Stable selection key. Reserved keys carry a fixed contract; deployment-defined keys start `x-`. */
  key: string;
  /** Short human-facing label, e.g. "About this person". */
  title: string;
  /** One line on what it CONTAINS (not where it comes from). */
  description: string;
  /** The SITUATION in which an assistant should reach for it. Not a restatement of the title. */
  useWhen: string;
  type: ContextSourceType;
  /**
   * The resource, for the IAM GRANT only. Account-qualified, so it is stripped before publication and
   * never travels in a profile export.
   */
  arn: string;
  /**
   * The name the READER needs: bucket (`s3-prefix`), table (`dynamodb-table`), parameter
   * (`ssm-parameter`), function (`lambda-service`).
   *
   * Separate from `arn` on purpose. The ARN is frequently a CloudFormation token (an imported value),
   * so it cannot be string-sliced at synth time to recover a name - and the reader needs a name, not a
   * policy resource. Publishing the locator is safe because it grants nothing: IAM is the gate, and a
   * catalog naming a resource the role cannot read simply fails closed.
   */
  locator: string;
  /** `s3-prefix` only: the key prefix within the bucket this entry exposes. Published, and READ. */
  prefix?: string;
  trust: ContextSourceTrust;
  availability: ContextSourceAvailability;
  /** Cap on the resolved value, so one source cannot push the persona out of the prompt. */
  maxBytes: number;
  fields: Record<string, ContextSourceField>;
  /** Reserved keys only: bumped major when a field is removed or retyped. Import checks the major. */
  contractVersion?: string;
}

/** Deployment-defined keys carry this prefix; everything else must match a reserved contract. */
export const DEPLOYMENT_KEY_PREFIX = 'x-';

/**
 * The CloudWatch namespace the runtime emits context source outcomes to, and the dashboard and alarm
 * in `assistant-profile-stack.ts` read from.
 *
 * Declared twice on purpose: the Lambda bundle and the CDK app are separate compilation units and
 * neither imports the other. `context-source-metric-contract.test.ts` asserts the two agree, because
 * a silent divergence would be invisible in the worst way - the runtime keeps emitting, the dashboard
 * keeps rendering, and every widget is empty with nothing to say why.
 */
export const CONTEXT_SOURCE_METRIC_NAMESPACE = 'AgentEchelon/ContextSources';

/**
 * Reserved key contracts. A deployment publishing one of these MUST satisfy the listed fields: it may
 * ADD fields, never remove or retype one. These are what make "the same profile works on another
 * deployment" a guarantee rather than a naming coincidence.
 *
 * Keys are named for the context scopes in SPEC-WELCOME-AND-CONTEXT ("The complete assistant-context
 * model": user, company/domain, conversation) so one vocabulary survives into the scoped-context-tree
 * model.
 */
export const RESERVED_CONTRACTS: Record<string, { requiredFields: string[]; contractVersion: string }> = {
  'user-profile': { requiredFields: ['displayName'], contractVersion: '1.0' },
  'company-docs': { requiredFields: ['digest'], contractVersion: '1.0' },
  'conversation': { requiredFields: [], contractVersion: '1.0' },
  'open-work': { requiredFields: [], contractVersion: '1.0' },
};

export interface CatalogValidationError {
  key: string;
  problem: string;
}

/**
 * Validate a catalog before it is published. Returns every problem rather than throwing on the first,
 * so a deployer fixes their file in one pass instead of one error per deploy.
 *
 * This is the SHAPE gate. It cannot check the IAM grant (the stack owns that) and does not read the
 * resource - an ARN that does not exist fails at deploy, which is the right place for it.
 */
export function validateContextSourceCatalog(entries: ContextSourceEntry[]): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];
  const seen = new Set<string>();

  for (const e of entries) {
    const key = e.key || '(missing key)';
    if (seen.has(key)) errors.push({ key, problem: 'duplicate key' });
    seen.add(key);

    // The scannable layer is REQUIRED, not best-effort: it is what a human reads to configure and
    // what a model reads to choose. A source without it is unusable by both.
    for (const field of ['title', 'description', 'useWhen'] as const) {
      if (!e[field]?.trim()) errors.push({ key, problem: `${field} is required` });
    }
    if (!e.arn?.trim()) errors.push({ key, problem: 'arn is required (the IAM grant resource)' });
    if (!e.locator?.trim()) errors.push({ key, problem: 'locator is required (the name the reader resolves)' });
    if (e.type === 's3-prefix' && !e.prefix?.trim()) {
      errors.push({ key, problem: "type 's3-prefix' requires a prefix" });
    }
    if (!(e.maxBytes > 0)) errors.push({ key, problem: 'maxBytes must be a positive number' });

    const fieldNames = Object.keys(e.fields || {});
    if (fieldNames.length === 0) errors.push({ key, problem: 'at least one field is required' });
    for (const [name, f] of Object.entries(e.fields || {})) {
      if (!f.description?.trim()) errors.push({ key, problem: `field '${name}' needs a description` });
    }

    const reserved = RESERVED_CONTRACTS[key];
    if (reserved) {
      for (const required of reserved.requiredFields) {
        if (!fieldNames.includes(required)) {
          errors.push({ key, problem: `reserved key must declare field '${required}'` });
        }
      }
    } else if (!key.startsWith(DEPLOYMENT_KEY_PREFIX)) {
      errors.push({
        key,
        problem: `unknown key: reserved keys are ${Object.keys(RESERVED_CONTRACTS).join(', ')}; `
          + `deployment-defined keys must start '${DEPLOYMENT_KEY_PREFIX}'`,
      });
    }
  }
  return errors;
}

/** One IAM statement a source needs. A list, because a type may need more than one shape. */
export interface ContextSourceGrantStatement {
  actions: string[];
  resources: string[];
  /** Conditions a bucket-level action needs to stay scoped (e.g. `s3:prefix` on ListBucket). */
  conditions?: Record<string, Record<string, unknown>>;
}

/**
 * The IAM statements one entry needs (INV-CTX-CAT-3).
 *
 * Scoped per type, never to the whole service: an `s3-prefix` entry grants its prefix and not the
 * bucket, so two classifications sharing a bucket still cannot read each other's context. The stack
 * emits exactly this beside the catalog publication, and the synth test asserts the resource strings -
 * a wildcard would satisfy "a grant exists" while removing the boundary this whole spec is for.
 */
export function contextSourceGrant(entry: ContextSourceEntry): ContextSourceGrantStatement[] {
  switch (entry.type) {
    case 's3-prefix':
      // `prefix` is required for this type by validation, so the resource can never widen to `/*`.
      //
      // ONE statement, object-level, and no `s3:ListBucket`. ListBucket used to ride along on this
      // same resource, which authorizes nothing at all: it is a BUCKET-level action and must name the
      // bucket ARN with an `s3:prefix` condition. Granting it on an object ARN was a permission that
      // read as present in a policy review and would have denied the moment anything listed.
      //
      // Nothing lists today - every reader fetches declared object keys - so the honest grant is the
      // one that is actually used. A future reader that enumerates a prefix must add the bucket-level
      // statement WITH its condition, which is the shape `assistant-profile-stack.ts` already uses for
      // the corpus.
      return [{ actions: ['s3:GetObject'], resources: [`${entry.arn}/${entry.prefix}*`] }];
    case 'dynamodb-table':
      return [{ actions: ['dynamodb:GetItem', 'dynamodb:Query'], resources: [entry.arn] }];
    case 'lambda-service':
      return [{ actions: ['lambda:InvokeFunction'], resources: [entry.arn] }];
    case 'ssm-parameter':
      return [{ actions: ['ssm:GetParameter'], resources: [entry.arn] }];
    default: {
      // Exhaustiveness: a new type must declare its grant here, or the build fails. Defaulting to a
      // permissive grant (or none) is how a source ships unreadable, or readable too widely.
      const never: never = entry.type;
      throw new Error(`context source '${entry.key}' has no IAM grant defined for type '${never}'`);
    }
  }
}

/**
 * The catalog as PUBLISHED to SSM: everything the runtime and the admin console need to resolve and
 * describe a source, minus the resource identifiers.
 *
 * Only the ARN is dropped - it is account-qualified, and the grant already binds it. The LOCATOR and
 * PREFIX are published because the reader needs them.
 *
 * Stripping them was a misapplied rule. The no-instance-identifiers constraint exists because a profile
 * MANIFEST travels between deployments; this parameter never leaves its own deployment. The cost of the
 * mistake was concrete: with no prefix to read, the S3 reader hardcoded `context/{classification}/`, so
 * the resource the IAM grant authorised and the resource actually read could name different locations.
 * Publishing a locator grants nothing - IAM remains the gate, and a catalog naming a resource the role
 * cannot read fails closed.
 */
export function publishableContextSource(entry: ContextSourceEntry): Omit<ContextSourceEntry, 'arn'> {
  const { arn: _arn, ...rest } = entry;
  return rest;
}

/**
 * What the deployment can tell a catalog about itself.
 *
 * A catalog must be able to name REAL resources, or the shipped example emits IAM statements against
 * placeholder ARNs and a fresh deploy is wrong out of the box. So the stack passes the identifiers it
 * already holds; the catalog composes them. A deployer's own file gets the same context and may of
 * course hard-code its own ARNs instead.
 */
export interface CatalogDeploymentContext {
  /** The classification this catalog is for - the isolation boundary the entries must respect. */
  classification: string;
  /** Bucket holding `context/{classification}/*`, as an ARN - for the IAM grant. */
  attachmentsBucketArn: string;
  /** The same bucket by NAME, for the reader. The ARN is usually a CloudFormation token (an imported
   *  value), so it cannot be sliced at synth time to recover a name. */
  attachmentsBucketName: string;
  /** The built-in per-user profile store, as an ARN - for the IAM grant. */
  userProfileTableArn: string;
  /** The same table by NAME, for the reader - the ARN is a token, for the same reason as the bucket. */
  userProfileTableName: string;
  region: string;
  account: string;
}

/** What a catalog module exports. */
export type ContextSourceCatalogFn = (ctx: CatalogDeploymentContext) => ContextSourceEntry[];

export interface LoadedCatalog {
  entries: ContextSourceEntry[];
  /** Which module supplied them, named in validation errors and logged at synth. */
  source: string;
}

/**
 * Load the deployment's catalog for one classification.
 *
 * Precedence: the deployer's gitignored `context-sources.local.ts`, then the tracked
 * `context-sources.example.ts`. A deployer never edits a tracked file, so upgrading cannot conflict
 * with their customization.
 *
 * `require` rather than `import` deliberately: this runs at CDK synth (CommonJS), and the local file
 * is legitimately ABSENT on a fresh clone, which a static import cannot express.
 */
export function loadContextSourceCatalog(
  ctx: CatalogDeploymentContext,
  /**
   * Module access, injectable for tests ONLY. Production passes nothing.
   *
   * A test cannot exercise the absent-versus-broken branch by writing a real
   * `context-sources.local.ts`: module resolution is cached per worker in both directions, and the
   * file lives on a path other test FILES read concurrently, so a filesystem-based test both lies to
   * itself and breaks its neighbours.
   */
  modules: {
    resolve?: (mod: string) => unknown;
    load?: (mod: string) => { contextSourceCatalog?: ContextSourceCatalogFn } | undefined;
  } = {},
): LoadedCatalog {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const resolveModule = modules.resolve ?? ((mod: string) => require.resolve(mod));
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const loadModule = modules.load ?? ((mod: string) => require(mod));

  for (const mod of ['./context-sources.local', './context-sources.example']) {
    // Does the file itself exist? Resolve it FIRST, separately from loading it.
    //
    // Catching MODULE_NOT_FOUND around the require conflated two different facts. A
    // `context-sources.local.ts` that exists but imports a module that does not raises
    // MODULE_NOT_FOUND too - for the INNER module - so a deployer's catalog with one bad import was
    // read as "no local file", the loop fell through, and synth succeeded while publishing the
    // EXAMPLE's keys and emitting the EXAMPLE's IAM grants. A silent change to the isolation boundary,
    // reported as a clean deploy.
    try {
      resolveModule(mod);
    } catch {
      continue; // genuinely absent: the normal case for the local file on a fresh clone
    }

    // From here the file EXISTS, so every failure is a real error in it and must not be swallowed.
    const loaded = loadModule(mod);
    if (typeof loaded?.contextSourceCatalog !== 'function') {
      throw new Error(`${mod} must export contextSourceCatalog(classification)`);
    }
    const entries = loaded.contextSourceCatalog(ctx);
    assertValidContextSourceCatalog(entries, mod);
    return { entries, source: mod };
  }
  // Neither file present: a valid state (no context sources configured), not an error.
  return { entries: [], source: '(none)' };
}

/**
 * Render the catalog as the human-facing reference table.
 *
 * GENERATED, never hand-maintained. The same `title`/`description`/`useWhen`/field descriptions feed
 * this table and the assistant's `## AVAILABLE CONTEXT` menu, so a hand-written copy drifts from what
 * the model actually reads - and that drift is invisible, because the doc looks right while the
 * assistant sees something else. `context-catalog-reference.test.ts` fails the build when the
 * committed file stops matching this output.
 *
 * Same discipline as `demo/context-digest-manifest.json`, the one curated source the per-classification
 * `_digest.json` files are built from.
 */
export function renderCatalogReference(entries: ContextSourceEntry[]): string {
  const field = (name: string, f: ContextSourceField) =>
    `\`${name}${f.optional ? '?' : ''}\` (${f.description})`;

  const rows = entries.map((e) => {
    const fields = Object.entries(e.fields).map(([n, f]) => field(n, f)).join(', ');
    const reserved = RESERVED_CONTRACTS[e.key] ? 'reserved' : 'deployment-defined';
    return `| \`${e.key}\` | **${e.title}** - ${e.description} | ${e.useWhen} | ${fields} `
      + `| ${e.availability} | ${e.trust} | ${reserved} |`;
  });

  return [
    '<!-- GENERATED by `npm run gen-context-reference`. Do not edit by hand: the catalog is the source,',
    '     and context-catalog-reference.test.ts fails the build if this file drifts from it. -->',
    '# Context catalog reference',
    '',
    'What an assistant can reference by key, and what each key yields. A profile selects from this by',
    'setting `contextSources`; the deployment decides which keys exist, per classification.',
    '',
    '`reserved` keys carry a fixed field contract across deployments, so a profile using only reserved',
    'keys is portable. `deployment-defined` keys (prefixed `x-`) are local to one deployment, and a',
    'profile using one is portable only to a deployment that agreed on it.',
    '',
    '| Key | Title / description | Use when | Fields | Availability | Trust | Scope |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Field contracts',
    '',
    'A deployment publishing a **reserved** key MUST satisfy its contract: it may ADD fields, never',
    'remove or retype one. Each carries a `contractVersion` - adding an optional field is a minor bump,',
    'removing or retyping is major, and import rejects a profile written against a different major.',
    'A contract may exist for a reserved key the shipped catalog above does not publish; it binds any',
    'deployment that chooses to publish that key.',
    '',
    ...Object.entries(RESERVED_CONTRACTS).map(
      ([key, c]) => `- \`${key}\` v${c.contractVersion} requires: `
        + (c.requiredFields.length ? c.requiredFields.map((f) => `\`${f}\``).join(', ') : '(no required fields)'),
    ),
    '',
  ].join('\n');
}

/** Throwing wrapper for the deploy path, so a malformed catalog fails the synth with every reason. */
export function assertValidContextSourceCatalog(entries: ContextSourceEntry[], source: string): void {
  const errors = validateContextSourceCatalog(entries);
  if (errors.length > 0) {
    throw new Error(
      `Invalid context source catalog (${source}):\n`
        + errors.map((e) => `  - ${e.key}: ${e.problem}`).join('\n'),
    );
  }
}
