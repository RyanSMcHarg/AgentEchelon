/**
 * THE TRUSTED-ISSUER REGISTRY: which identity providers a deployment accepts a person from, and what
 * each one's people may reach.
 *
 * A person is their AppInstanceUser (README.md:3). An issuer is only a way to get a session as one, so
 * the registry is the one place that says which issuers count, how a token from each names its subject,
 * and where that person's clearance comes from. Every path that reads a token or keys a person reads it
 * here: the credential exchange, the caller resolver (`lambda/src/lib/auth.ts`), the directory, the
 * offboarding events, the notification pools and the authorizers' pool sets. Nothing branches on which
 * file ran; what differs between two people follows from their issuer's entry.
 *
 * Declared as `issuers` in `deploy.config.json`. Absent, the deployment trusts its own pool alone
 * (`DEFAULT_ISSUERS`), which is what every deployment did before the registry existed.
 *
 * ── THE ROW KEY ──────────────────────────────────────────────────────────────────────────────────
 *
 * `Identities` keys a person's sign-in on `<registry id>|<declared subject>`, never on the raw `iss`.
 * The registry id is stable across an issuer URL that moves (an Entra v1/v2 change), and the declared
 * subject is the claim (or claims) the issuer promises are unique and permanent: `sub` for a Cognito
 * pool, `tid` and `oid` for Entra. The same subject value under two issuers is two people.
 *
 * ── NO FALLBACK REACH (Q5) ───────────────────────────────────────────────────────────────────────
 *
 * Every entry declares a clearance source AND the classifications that source may grant. An entry with no
 * source is refused at synth, and a token from an issuer the registry does not declare reaches
 * nothing. The sources:
 *
 *  - `groups`: the person's AgentEchelon groups, mapped through the profile registry's `groupClearance`.
 *    `groups: true` on a `cognito-pool`, whose own groups are AgentEchelon groups; `groups: { map }` on
 *    `cognito-federated`, `oidc` and `oidc-entra`, translating the provider's groups (`groupsOf`).
 *  - `mapping`: a declared claim whose values map to classifications. A value the mapping does not
 *    declare reaches nothing. The claim is on the person's token and nowhere else this deployment reads,
 *    so the credential exchange records what it decided on the person's `Identities` row
 *    (`clearanceDecision`, `lambda/src/lib/person-identity.ts`), and the readers that have no token (the
 *    membership audit, the reconcile, the router) read that record as evidence of the last sign-in. A
 *    record older than `recordMaxAgeDays` (default `CLEARANCE_RECORD_MAX_AGE_DAYS`) is flagged as stale.
 *    Nothing grants from a record: it is evidence for a finding, never a clearance.
 *  - `fixed`: a fixed classification set.
 *  - `oneChannel`: the one-conversation session at a named classification. The person is vended a
 *    credential naming one conversation, read and post only, on the `restricted` role, and their
 *    conversations are created at that classification. Never a default: an issuer gets it only by
 *    declaring it.
 *
 * ── THE GUEST ────────────────────────────────────────────────────────────────────────────────────
 *
 * An entry of kind `guest` is the platform's own issuer for an anonymous visitor (A7). Its tokens are
 * signed by this deployment's KMS key (ES256, `kid` per key generation) and verified at the edge like
 * every other issuer's. Its clearance is `fixed` at one outside classification (`audience: 'outside'`,
 * `lib/config/profiles.ts`), and its people are vended one conversation, their own, under the
 * guest-session boundary. Its `guest` block declares the abuse controls guest start runs before it
 * signs anything (L16): the captcha, the per-address limit and the token lifetimes. Production refuses
 * the captcha vendor's test keys, any setting this block does not know (there is no bypass), and a
 * limit of 0 (`issuerErrors` with `environment: 'production'`).
 *
 * ── THE HOST ASSERTION ───────────────────────────────────────────────────────────────────────────
 *
 * An entry of kind `host-assertion` is a host application that signs a short-lived JWT for the person it
 * has already signed in, such as a Salesforce org for one of its users (A9, V7). It has no discovery
 * endpoint: the entry pins the host's public keys (`hostAssertion.publicKeys`, by `kid`), and rotation is
 * the operator's, by declaring the next key beside the current one. An assertion's `aud` is this
 * deployment's id, its `exp` is at most `hostAssertion.maxMinutes` ahead, and its `jti` is recorded once
 * at the edge and consumed once by the exchange before anything is vended, so an assertion is never
 * accepted twice. It is accepted on the credential exchange route and nowhere else. Its clearance is a
 * declared `mapping` (a permission-set claim, Q5) or a `fixed` set, within its declared classifications.
 *
 * It is `provisioned-only` (P-13): the exchange never mints a person for it. A subject reaches only the
 * AppInstanceUser `provisionSubject` pre-assigned (a `pending` row, which the exchange binds once), and an
 * unknown subject is refused with nothing created. Any signer in the host can sign for any of its users,
 * so the host is trusted as one issuer, bounded by its classifications (R14).
 *
 * ── THE INVITATION LINK ──────────────────────────────────────────────────────────────────────────
 *
 * An entry of kind `invitation-link` is the platform's own issuer for a person who redeems a `link`
 * invitation (M-10) from its landing page, with no sign-in. It signs no token and the edge never sees
 * one: the redemption itself (`POST /invitations/redeem`, on the credential exchange) is the credential,
 * spent once, and what it vends is a one-conversation session pinned to the invitation's AppInstanceUser,
 * under the `link` session's permissions boundary, for at most `LINK_SESSION_MAX_MINUTES`.
 * Its clearance is the `fixed` set of classifications a link session may be vended at, within its
 * classifications: the session is vended at the invited conversation's classification, and only when that is in
 * this set and in the conversation type's `linkClassifications` (`lib/config/conversation-types.ts`). Its
 * `invitationLink` block declares the abuse controls the redemption runs first (L16), as the guest's
 * does: the kill switch, the per-address limit and the captcha. One per deployment.
 *
 * A held classification whose grants reach past the issuer's classifications is dropped, so they bind
 * whatever the source says.
 */
import { createPublicKey } from 'crypto';
import type { Holder, ProfileRegistry } from '../profile-registry';
import { CONVERSATION_TYPES, GUEST_VISITOR_TYPE, admittedIssuersOf, invitationPolicyOf } from './conversation-types';

/**
 * The outside classifications an anonymous visitor's conversation is opened at: those the
 * `guest-visitor` type permits. Only a guest issuer reaches them. Every other outside classification
 * (the customer) is reached by a signed-in issuer whose classifications are all outside (path B's target).
 */
export function visitorClassifications(outside: readonly string[]): string[] {
  const permitted = CONVERSATION_TYPES[GUEST_VISITOR_TYPE]?.classifications ?? [];
  return outside.filter((v) => (permitted as readonly string[]).includes(v));
}

// ── KINDS ────────────────────────────────────────────────────────────────────────────────────────

export const ISSUER_KINDS = [
  'cognito-pool',
  'cognito-federated',
  'oidc',
  'oidc-entra',
  'guest',
  'host-assertion',
  'invitation-link',
] as const;
export type IssuerKind = (typeof ISSUER_KINDS)[number];

/**
 * Kinds the registry parses but synth refuses, each with why. Each is built by its own later change,
 * which deletes its line here. Every kind is built.
 */
export const NOT_BUILT_KINDS: Readonly<Partial<Record<IssuerKind, string>>> = {};

/** Kinds whose people present no token anywhere: the edge verifies none and skips the entry. */
export const NO_TOKEN_KINDS: readonly IssuerKind[] = ['invitation-link'];

/** Kinds that never declare `admin: true` (A6): their people are outside the deployment's staff. */
export const NEVER_ADMIN_KINDS: readonly IssuerKind[] = ['guest', 'invitation-link', 'host-assertion'];

const COGNITO_KINDS: readonly IssuerKind[] = ['cognito-pool', 'cognito-federated'];
const OIDC_KINDS: readonly IssuerKind[] = ['oidc', 'oidc-entra'];

/** Issuers whose `iss` every account of the provider shares, so an entry naming one must narrow it (`requiredClaims`). */
export const SHARED_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];

/** The signing algorithms an issuer may declare. Never `none`, never HMAC (a shared secret), never EdDSA. */
export const SIGNING_ALGORITHMS = ['RS256', 'ES256'] as const;
export type SigningAlgorithm = (typeof SIGNING_ALGORITHMS)[number];

/**
 * THE SAMPLE HOST PAGE (`examples/widget-host/`), as an `allowedOrigins` value. A guest issuer that lists
 * `"widget-host"` among its origins gets the sample page from the opt-in `WidgetHost` stack (its own private
 * bucket behind its own CloudFront distribution, `lib/stacks/widget-host-stack.ts`), and the value stands for
 * that distribution's origin, which the CDK app takes from the stack, never from a typed domain: the widget's
 * `frame-ancestors` names it. Declaring it is the opt-in, so the page exists only in a deployment that asks
 * for it. Allowed on a `guest` entry only, and refused in production.
 */
export const WIDGET_HOST_ORIGIN = 'widget-host';

/** Whether the registry declares the sample host page (`WIDGET_HOST_ORIGIN`). */
export function declaresWidgetHost(entries: readonly object[]): boolean {
  return entries.some((e) => ((e as { allowedOrigins?: readonly string[] }).allowedOrigins ?? []).includes(WIDGET_HOST_ORIGIN));
}

/** The registry id of this deployment's own pool, `pool: 'self'`. Fixed, because scripts key rows on it. */
export const DEPLOYMENT_ISSUER_ID = 'deployment';

export const PROVISIONING = ['on-first-sign-in', 'provisioned-only', 'scim'] as const;
export type Provisioning = (typeof PROVISIONING)[number];

/** Provisioning modes synth refuses, with why. */
const NOT_BUILT_PROVISIONING: Readonly<Partial<Record<Provisioning, string>>> = {
  scim: 'provisioning "scim" is NOT BUILT: this deployment has no SCIM receiver',
};

/**
 * How an entry's people come into being: `on-first-sign-in` (the exchange mints the person at their first
 * sign-in) or `provisioned-only` (only a subject `provisionSubject` pre-assigned is admitted, P-13). A
 * `host-assertion` entry is `provisioned-only` whether or not it says so.
 */
export function provisioningOf(e: { kind: IssuerKind; provisioning?: string }): Provisioning {
  if (e.kind === 'host-assertion') return 'provisioned-only';
  return e.provisioning === 'provisioned-only' || e.provisioning === 'scim' ? e.provisioning : 'on-first-sign-in';
}

/** True for an issuer whose subjects are admitted only once provisioned (`provisioned-only`). */
export function isProvisionedOnly(issuer: { kind: IssuerKind; provisioning?: string } | null | undefined): boolean {
  return !!issuer && provisioningOf(issuer) === 'provisioned-only';
}

/** Lifecycle sources that drive offboarding. `scim` and `connector:<id>` are parsed and refused. */
export type Lifecycle = 'cloudtrail-cognito' | 'none' | 'scim' | `connector:${string}`;

/**
 * THE DIRECTORY ADAPTERS a person's name, contact and groups are read through (C5), one per issuer.
 *
 *  - `cognito`: the issuer's own pool, read live (`AdminGetUser`, its groups). A Cognito kind's default.
 *  - `claims`: for an issuer with no directory of its own. The contact claims of the person's last
 *    sign-in, held encrypted under `<personId>#contact#<issuerId>` in the user-profile table, replaced at
 *    each sign-in, expired after 90 days without one, and erased with the person.
 *  - `none`: nothing is read; the person is named by their AppInstanceUser and has no contact. Every
 *    other kind's default.
 *
 * The others parse and synth refuses them, each with why.
 */
export const DIRECTORIES = ['cognito', 'claims', 'none'] as const;
export type DirectoryAdapter = (typeof DIRECTORIES)[number];

/** Directory adapters the registry parses but synth refuses. `connector:<id>` is matched by its prefix. */
export const NOT_BUILT_DIRECTORIES: Readonly<Record<string, string>> = {
  'identity-store': 'no IAM Identity Center adapter exists',
  graph: 'no Microsoft Graph connector exists',
  scim: 'this deployment has no SCIM receiver',
  'connector:': 'no connector serves as a directory adapter',
};

/** Why a directory value is refused as not built, or null when it is not one of those. */
export function notBuiltDirectory(value: string): string | null {
  if (value.startsWith('connector:')) return NOT_BUILT_DIRECTORIES['connector:'];
  if (!Object.prototype.hasOwnProperty.call(NOT_BUILT_DIRECTORIES, value)) return null;
  return NOT_BUILT_DIRECTORIES[value];
}

/** The directory an entry reads through: its declared one, else `cognito` for a Cognito kind and `none` otherwise. */
export function directoryOf(e: { kind: IssuerKind; directory?: string }): DirectoryAdapter {
  if (e.directory && (DIRECTORIES as readonly string[]).includes(e.directory)) return e.directory as DirectoryAdapter;
  return COGNITO_KINDS.includes(e.kind) ? 'cognito' : 'none';
}

// ── THE CONFIG ───────────────────────────────────────────────────────────────────────────────────

/**
 * How old a recorded clearance decision may be, by default, before the readers with no token flag it as
 * stale rather than read it as evidence: 30 days. A person who signs in at all refreshes it on every
 * credential exchange.
 */
export const CLEARANCE_RECORD_MAX_AGE_DAYS = 30;

/** The age, in milliseconds, past which a mapping issuer's recorded decision is stale. */
export function clearanceRecordMaxAgeMs(c: ClearanceConfig | undefined): number {
  const declared = c && 'mapping' in c ? c.mapping.recordMaxAgeDays
    : c && 'groups' in c && isTranslation(c.groups) ? c.groups.recordMaxAgeDays : undefined;
  const days = typeof declared === 'number' ? declared : CLEARANCE_RECORD_MAX_AGE_DAYS;
  return days * 86_400_000;
}

/**
 * A PROVIDER'S GROUPS, TRANSLATED INTO AGENTECHELON GROUPS (SPEC-CREDENTIAL-EXCHANGE §4b, "A person's groups").
 * The provider group is the value exactly as the token carries it (an Entra group ObjectId, never a display
 * name); the target is an AgentEchelon group (`isAgentEchelonGroup`). A provider group the map does not
 * name reaches nothing, so an outside administrator's group called `admins` means nothing until mapped.
 */
export interface GroupsTranslation {
  map: Record<string, string | string[]>;
  /**
   * `cognito-federated` only, and required there: the operator's statement that the provider sends the
   * groups attribute even when it is empty. Cognito keeps a mapped value the provider stops sending, so
   * without it a person removed from their last group would keep it.
   */
  emptyGroupsSent?: boolean;
  /** How old the exchange's recorded decision may be before the offline readers flag it. Default 30 days. */
  recordMaxAgeDays?: number;
}

/**
 * THE CLEARANCE SOURCE AND THE CLASSIFICATIONS IT MAY GRANT. A `groups` source may leave `classifications` out: its
 * people then reach whatever their groups clear for among the deployment's own people's classifications (the admin
 * plane only with `admin: true`), read from the runtime registry (`issuerClassificationsOf`), so a classification
 * added later is reached with no change to the issuer's entry. Every other source lists them.
 */
export type ClearanceConfig =
  | { classifications?: string[]; groups: true | GroupsTranslation }
  | ({ classifications: string[] } & (
    | { mapping: { claim: string; values: Record<string, string | string[]>; recordMaxAgeDays?: number } }
    | { fixed: string[] }
    | { oneChannel: string }
  ));

/** What an issuer's reach is read from: its clearance and whether it declares `admin: true`. */
export type ReachEntry = { clearance: ClearanceConfig; admin?: boolean };

/** What the no-list reach is read from in the registry the caller holds. */
export type ReachRegistry = Pick<ProfileRegistry, 'memberClassificationValues' | 'adminPlaneValues'>;

/**
 * THE CLASSIFICATIONS AN ISSUER MAY GRANT: the ones its entry lists, or, for a `groups` source that lists none,
 * the classifications of the deployment's own people (every one that is not an outside one), as the registry the
 * caller holds declares them (the deployment's set at synth, the runtime registry in a handler). No group clears for
 * an outside classification (`validateProfilesConfig`), so an issuer for outside people lists its classifications.
 * The admin plane is among them only when the entry declares `admin: true`: a foreign issuer's group called
 * `admins` reaches no admin plane until its entry says its people may be admins.
 */
export function issuerClassificationsOf(e: ReachEntry, profiles: ReachRegistry): string[] {
  const c = e.clearance;
  if (c.classifications) return c.classifications;
  const plane = new Set(profiles.adminPlaneValues());
  return profiles.memberClassificationValues().filter((v) => e.admin === true || !plane.has(v));
}

/**
 * THE GUEST ISSUER'S OWN SETTINGS (`kind: 'guest'`). Every field has a default, and a field this block
 * does not know is refused, so no bypass can be declared by naming one.
 */
export interface GuestIssuerSettings {
  /**
   * The signing key generations, oldest first, each a `kid`. The last signs; every one listed verifies.
   * Rotation is appending a generation, waiting one token lifetime plus the edge cache, then removing the
   * old one (docs/guides/admin/GUEST-ISSUER.md). Default `['g1']`.
   */
  signingKeys?: string[];
  /** How long a guest token lasts, in minutes. Default 10, at most 15. */
  tokenMinutes?: number;
  /**
   * How long one refresh credential lasts, in minutes, before it must be rotated. Default 60. Never past
   * the visitor's own expiry (`GUEST_LIFETIME_HOURS`).
   */
  refreshMinutes?: number;
  /** Guest starts allowed per source address (IPv4, or an IPv6 /64) per window. Default 5 per 60 minutes. */
  perIpLimit?: { max: number; windowMinutes: number };
  /**
   * The captcha guest start verifies server-side (Cloudflare Turnstile). Outside production, absent
   * means the vendor's published always-pass test keys; in production a site key and a secret
   * reference are required, and a test key is refused. The secret is named, never held here: a Secrets
   * Manager secret (`secretName`) or an SSM SecureString (`secretParameter`).
   */
  captcha?: { vendor: 'turnstile'; siteKey?: string; secretName?: string; secretParameter?: string };
  /** The privacy-notice version the widget shows before the first message. Default `sample-1`. */
  noticeVersion?: string;
  /**
   * HOW A VISITOR'S REGISTRATION BECOMES AN ACCOUNT'S SIGN-IN LINK (path B, `lambda/src/guest-upgrade.ts`).
   * `approval: 'none'` (the default) sends the claim email the moment the visitor registers; `'admin'` holds
   * the registration until an operator approves it from the admin console (`approve-registrations`), and
   * only then sends it. A declaration, read at synth: `'admin'` needs the `admin` capability.
   */
  registration?: { approval?: RegistrationApproval };
}

/** Whether a registration waits for an operator before its claim email is sent. */
export type RegistrationApproval = 'none' | 'admin';
export const REGISTRATION_APPROVALS: readonly RegistrationApproval[] = ['none', 'admin'];

/** The guest settings with every default applied. */
export interface ResolvedGuestSettings {
  signingKeys: string[];
  tokenMinutes: number;
  refreshMinutes: number;
  perIpLimit: { max: number; windowMinutes: number };
  captcha: { vendor: 'turnstile'; siteKey: string; secretName?: string; secretParameter?: string; testKeys: boolean };
  noticeVersion: string;
  registrationApproval: RegistrationApproval;
}

/** How long a visitor exists: their AppInstanceUser expires this long after it is created. */
export const GUEST_LIFETIME_HOURS = 24;
export const GUEST_TOKEN_MAX_MINUTES = 15;

/**
 * Cloudflare Turnstile's published test keys (developers.cloudflare.com/turnstile/troubleshooting/testing).
 * The always-pass pair is what a non-production guest issuer uses when it declares no captcha; every one
 * of them is refused in production.
 */
export const TURNSTILE_TEST_SITE_KEYS: readonly string[] = [
  '1x00000000000000000000AA', '2x00000000000000000000AB', '1x00000000000000000000BB', '2x00000000000000000000BB', '3x00000000000000000000FF',
];
export const TURNSTILE_TEST_SECRET_PASS = '1x0000000000000000000000000000000AA';
/** A site key or secret shaped like one of the vendor's test keys: a digit, `x`, then zeros. */
export const isTurnstileTestKey = (k: string): boolean => TURNSTILE_TEST_SITE_KEYS.includes(k) || /^[123]x0{10,}[A-F]{2}$/.test(k);

const GUEST_FIELDS = ['signingKeys', 'tokenMinutes', 'refreshMinutes', 'perIpLimit', 'captcha', 'noticeVersion', 'registration'];
const REGISTRATION_FIELDS = ['approval'];
const CAPTCHA_FIELDS = ['vendor', 'siteKey', 'secretName', 'secretParameter'];

/** The guest settings of an entry with every default applied. */
export function guestSettingsOf(e: Pick<IssuerConfig, 'guest'>): ResolvedGuestSettings {
  const g = e.guest ?? {};
  const captcha = g.captcha;
  const testKeys = !captcha?.siteKey && !captcha?.secretName && !captcha?.secretParameter;
  return {
    signingKeys: g.signingKeys?.length ? [...g.signingKeys] : ['g1'],
    tokenMinutes: g.tokenMinutes ?? 10,
    refreshMinutes: g.refreshMinutes ?? 60,
    perIpLimit: g.perIpLimit ? { ...g.perIpLimit } : { max: 5, windowMinutes: 60 },
    captcha: {
      vendor: 'turnstile',
      siteKey: captcha?.siteKey ?? TURNSTILE_TEST_SITE_KEYS[0],
      ...(captcha?.secretName ? { secretName: captcha.secretName } : {}),
      ...(captcha?.secretParameter ? { secretParameter: captcha.secretParameter } : {}),
      testKeys,
    },
    noticeVersion: g.noticeVersion ?? 'sample-1',
    registrationApproval: g.registration?.approval ?? 'none',
  };
}

/** The issuer URI a guest entry's tokens carry as `iss`: this deployment and the entry, never a URL. */
export function guestIssuerUri(deploymentId: string, issuerId: string): string {
  return `urn:agentechelon:${deploymentId}:issuer:${issuerId}`;
}

/** Every reason a guest entry's own settings cannot be synthesized. */
function guestErrors(e: IssuerConfig, at: string, environment: string): string[] {
  const errors: string[] = [];
  const production = environment === 'production';
  const g = e.guest;
  if (g !== undefined && (!g || typeof g !== 'object' || Array.isArray(g))) return [`${at}: guest is an object of guest settings`];
  for (const k of Object.keys(g ?? {})) {
    if (!GUEST_FIELDS.includes(k)) {
      errors.push(`${at}: guest.${k} is not a guest setting; the settings are ${GUEST_FIELDS.join(', ')}. `
        + 'There is no bypass of the abuse controls, so a setting this block does not know is refused');
    }
  }
  const settings: GuestIssuerSettings = g ?? {};
  if (settings.signingKeys !== undefined) {
    if (!isStringList(settings.signingKeys) || !settings.signingKeys.length || !settings.signingKeys.every((k) => /^g[1-9][0-9]{0,3}$/.test(k))) {
      errors.push(`${at}: guest.signingKeys lists key generations, oldest first, each g1, g2, ...`);
    } else if (new Set(settings.signingKeys).size !== settings.signingKeys.length) {
      errors.push(`${at}: guest.signingKeys names a generation twice`);
    } else if (settings.signingKeys.length > 2) {
      errors.push(`${at}: guest.signingKeys lists at most two generations: the one signing, and the one it replaces for one token lifetime`);
    }
  }
  const minutes = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
  if (settings.tokenMinutes !== undefined && !minutes(settings.tokenMinutes, GUEST_TOKEN_MAX_MINUTES)) {
    errors.push(`${at}: guest.tokenMinutes is a whole number of minutes from 1 to ${GUEST_TOKEN_MAX_MINUTES}`);
  }
  if (settings.refreshMinutes !== undefined && !minutes(settings.refreshMinutes, GUEST_LIFETIME_HOURS * 60)) {
    errors.push(`${at}: guest.refreshMinutes is a whole number of minutes from 1 to ${GUEST_LIFETIME_HOURS * 60}`);
  }
  errors.push(...abuseControlErrors(settings, at, { block: 'guest', noun: 'guest issuer', counts: 'guest starts', production }));
  if (settings.noticeVersion !== undefined && (typeof settings.noticeVersion !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(settings.noticeVersion))) {
    errors.push(`${at}: guest.noticeVersion is a short version label (letters, digits, dot, dash, underscore)`);
  }
  if (settings.registration !== undefined) {
    const r = settings.registration as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push(`${at}: guest.registration is { approval }: how a visitor's registration reaches its claim email`);
    } else {
      for (const k of Object.keys(r)) {
        if (!REGISTRATION_FIELDS.includes(k)) errors.push(`${at}: guest.registration.${k} is not a registration setting; the settings are ${REGISTRATION_FIELDS.join(', ')}`);
      }
      if (r.approval !== undefined && !REGISTRATION_APPROVALS.includes(r.approval as RegistrationApproval)) {
        errors.push(`${at}: guest.registration.approval is ${REGISTRATION_APPROVALS.map((a) => `"${a}"`).join(' or ')}: `
          + 'straight through, or held until an operator approves it');
      }
    }
  }
  return errors;
}

/** The captcha a guest or invitation-link block declares, as declared. */
type CaptchaDeclaration = { vendor: 'turnstile'; siteKey?: string; secretName?: string; secretParameter?: string };

/**
 * Every reason an unauthenticated entry point's abuse controls cannot be synthesized (L16): its
 * per-address limit and its captcha, with production refusing the vendor's test keys, a missing secret and
 * a limit of 0. Shared by the guest block and the invitation-link block, which run the same controls.
 */
function abuseControlErrors(
  settings: { perIpLimit?: { max: number; windowMinutes: number }; captcha?: CaptchaDeclaration },
  at: string,
  where: { block: string; noun: string; counts: string; production: boolean },
): string[] {
  const errors: string[] = [];
  const { block, noun, counts, production } = where;
  const minutes = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
  if (settings.perIpLimit !== undefined) {
    const l = settings.perIpLimit as { max?: unknown; windowMinutes?: unknown } | null;
    const extra = l && typeof l === 'object' ? Object.keys(l).filter((k) => k !== 'max' && k !== 'windowMinutes') : [];
    if (!l || typeof l !== 'object' || typeof l.max !== 'number' || !Number.isInteger(l.max) || l.max < 0
      || !minutes(l.windowMinutes, 24 * 60) || extra.length) {
      errors.push(`${at}: ${block}.perIpLimit is { max, windowMinutes }: ${counts} per source address per window`);
    } else if (l.max === 0 && production) {
      errors.push(`${at}: ${block}.perIpLimit.max is 0, which limits nothing; a production ${noun} declares a limit`);
    }
  }
  if (settings.captcha !== undefined) {
    const c = settings.captcha as unknown as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || Array.isArray(c)) errors.push(`${at}: ${block}.captcha is { vendor, siteKey, secretName or secretParameter }`);
    else {
      for (const k of Object.keys(c)) if (!CAPTCHA_FIELDS.includes(k)) errors.push(`${at}: ${block}.captcha.${k} is not a captcha setting; the settings are ${CAPTCHA_FIELDS.join(', ')}`);
      if (c.vendor !== 'turnstile') errors.push(`${at}: ${block}.captcha.vendor is "turnstile"; it is the one captcha built`);
      for (const k of ['siteKey', 'secretName', 'secretParameter']) {
        if (c[k] !== undefined && (typeof c[k] !== 'string' || !(c[k] as string).trim())) errors.push(`${at}: ${block}.captcha.${k} is a non-empty string`);
      }
      if (c.secretName !== undefined && c.secretParameter !== undefined) errors.push(`${at}: ${block}.captcha names its secret once, by secretName or by secretParameter`);
      if (typeof c.secretParameter === 'string' && !c.secretParameter.startsWith('/')) errors.push(`${at}: ${block}.captcha.secretParameter is an SSM parameter name, starting with /`);
    }
  }
  // PRODUCTION: NO TEST KEY, NO MISSING SECRET (L16, R12).
  if (production) {
    const c = (settings.captcha ?? {}) as { siteKey?: string; secretName?: string; secretParameter?: string };
    if (!c.siteKey) errors.push(`${at}: a production ${noun} declares ${block}.captcha.siteKey; the vendor's test keys are for non-production instances`);
    else if (isTurnstileTestKey(c.siteKey)) errors.push(`${at}: ${block}.captcha.siteKey is one of the vendor's published test keys, which production refuses`);
    if (!c.secretName && !c.secretParameter) errors.push(`${at}: a production ${noun} names its captcha secret (${block}.captcha.secretName or secretParameter)`);
    for (const v of [c.secretName, c.secretParameter]) {
      if (typeof v === 'string' && isTurnstileTestKey(v)) errors.push(`${at}: the captcha secret is named by a test key's value; name the secret, never the key`);
    }
  }
  return errors;
}

/** The captcha a block declares, with the vendor's test keys outside production when it declares none. */
function resolvedCaptcha(captcha: CaptchaDeclaration | undefined): ResolvedGuestSettings['captcha'] {
  const testKeys = !captcha?.siteKey && !captcha?.secretName && !captcha?.secretParameter;
  return {
    vendor: 'turnstile',
    siteKey: captcha?.siteKey ?? TURNSTILE_TEST_SITE_KEYS[0],
    ...(captcha?.secretName ? { secretName: captcha.secretName } : {}),
    ...(captcha?.secretParameter ? { secretParameter: captcha.secretParameter } : {}),
    testKeys,
  };
}

// ── THE INVITATION LINK'S OWN SETTINGS ───────────────────────────────────────────────────────────

/**
 * THE INVITATION-LINK ISSUER'S SETTINGS (`kind: 'invitation-link'`, `invitationLink`). Every field has a
 * default, and a field this block does not know is refused, so no bypass can be declared by naming one.
 */
export interface InvitationLinkSettings {
  /** How long a link session's credential lasts, in minutes. Default and most `LINK_SESSION_MAX_MINUTES`. */
  sessionMinutes?: number;
  /** Redemptions allowed per source address (IPv4, or an IPv6 /64) per window. Default 10 per 60 minutes. */
  perIpLimit?: { max: number; windowMinutes: number };
  /** The captcha redemption verifies server-side, declared as the guest's is. */
  captcha?: CaptchaDeclaration;
}

/** The invitation-link settings with every default applied. */
export interface ResolvedInvitationLinkSettings {
  sessionMinutes: number;
  perIpLimit: { max: number; windowMinutes: number };
  captcha: ResolvedGuestSettings['captcha'];
}

/** How long a `link` session lasts at most: the STS minimum, so revocation ends it soon. */
export const LINK_SESSION_MAX_MINUTES = 15;
const INVITATION_LINK_FIELDS = ['sessionMinutes', 'perIpLimit', 'captcha'];

/** The invitation-link settings of an entry with every default applied. */
export function invitationLinkSettingsOf(e: Pick<IssuerConfig, 'invitationLink'>): ResolvedInvitationLinkSettings {
  const s = e.invitationLink ?? {};
  return {
    sessionMinutes: s.sessionMinutes ?? LINK_SESSION_MAX_MINUTES,
    perIpLimit: s.perIpLimit ? { ...s.perIpLimit } : { max: 10, windowMinutes: 60 },
    captcha: resolvedCaptcha(s.captcha),
  };
}

/** Every reason an invitation-link entry cannot be synthesized. */
function invitationLinkErrors(e: IssuerConfig, at: string, environment: string, profiles: Profiles): string[] {
  const errors: string[] = [];
  // THE PLATFORM'S OWN ISSUER, AND NOT A TOKEN ISSUER: nothing about a token or a directory is declared.
  for (const f of ['pool', 'providerName', 'issuer', 'discoveryUrl', 'tenants', 'tokenVersion', 'audience', 'tokenType', 'subject',
    'groupsClaim', 'adminGroups', 'algorithm', 'tokenUse', 'allowedOrigins', 'provisioning'] as const) {
    if (e[f] !== undefined) errors.push(`${at}: an invitation-link entry declares no ${f}; it signs no token, and its people are the invitations' own`);
  }
  if (e.directory !== undefined && e.directory !== 'none') errors.push(`${at}: an invitation-link person has no directory; directory is "none" or absent`);
  if (e.lifecycle !== undefined && e.lifecycle !== 'none') errors.push(`${at}: an invitation-link person is offboarded with the invitation; lifecycle is "none" or absent`);
  const c = e.clearance as { fixed?: unknown; classifications?: unknown } | undefined;
  if (clearanceSourceOf(e.clearance) !== 'fixed') {
    errors.push(`${at}: an invitation-link issuer's clearance is the fixed set of classifications a link session may be vended at, within its declared classifications`);
  } else if (isStringList(c?.fixed)) {
    for (const v of c!.fixed as string[]) {
      if (!profiles.isConversational(v)) errors.push(`${at}: fixed names "${v}", which is not a classification a conversation is held at`);
    }
  }
  const s = e.invitationLink as unknown as Record<string, unknown> | undefined;
  if (s !== undefined && (!s || typeof s !== 'object' || Array.isArray(s))) return [...errors, `${at}: invitationLink is an object of invitation-link settings`];
  for (const k of Object.keys(s ?? {})) {
    if (!INVITATION_LINK_FIELDS.includes(k)) {
      errors.push(`${at}: invitationLink.${k} is not an invitation-link setting; the settings are ${INVITATION_LINK_FIELDS.join(', ')}. `
        + 'There is no bypass of the abuse controls, so a setting this block does not know is refused');
    }
  }
  const settings: InvitationLinkSettings = (s ?? {}) as InvitationLinkSettings;
  const minutes = settings.sessionMinutes;
  if (minutes !== undefined && !(typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 15 && minutes <= LINK_SESSION_MAX_MINUTES)) {
    errors.push(`${at}: invitationLink.sessionMinutes is ${LINK_SESSION_MAX_MINUTES}: a link session lasts the shortest credential STS vends`);
  }
  errors.push(...abuseControlErrors(settings, at, {
    block: 'invitationLink', noun: 'invitation-link issuer', counts: 'link redemptions', production: environment === 'production',
  }));
  return errors;
}

// ── THE HOST ASSERTION'S OWN SETTINGS ────────────────────────────────────────────────────────────

/** A `host-assertion` entry's settings (`hostAssertion`). A field this block does not know is refused. */
export interface HostAssertionSettings {
  /**
   * The host's public keys, by the `kid` its assertions carry: each the base64 DER of the key's
   * SubjectPublicKeyInfo (the body of a `-----BEGIN PUBLIC KEY-----` block, on one line). An RSA key of at
   * least 2048 bits for `RS256` (the default), a P-256 key for `ES256`. One or two: the key that signs, and
   * during a rotation the one it replaces.
   */
  publicKeys: Record<string, string>;
  /** How far ahead an assertion's `exp` may be, and how long from `iat` to `exp`, in minutes. Default 5, at most 10. */
  maxMinutes?: number;
}

export const HOST_ASSERTION_DEFAULT_MINUTES = 5;
export const HOST_ASSERTION_MAX_MINUTES = 10;
const HOST_ASSERTION_FIELDS = ['publicKeys', 'maxMinutes'];
const KID = /^[A-Za-z0-9._-]{1,64}$/;

/** The assertion lifetime an entry allows, in seconds. */
export function hostAssertionMaxSeconds(e: Pick<IssuerConfig, 'hostAssertion'>): number {
  return (e.hostAssertion?.maxMinutes ?? HOST_ASSERTION_DEFAULT_MINUTES) * 60;
}

/** Why a pinned key cannot verify `algorithm`, or null when it can. */
export function pinnedKeyError(spkiBase64: unknown, algorithm: SigningAlgorithm): string | null {
  if (typeof spkiBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(spkiBase64)) return 'is not base64 DER (the body of a PUBLIC KEY block, on one line)';
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return 'is not a public key (SubjectPublicKeyInfo, DER)';
  }
  if (algorithm === 'RS256') {
    if (key.asymmetricKeyType !== 'rsa') return `is a ${key.asymmetricKeyType} key, and RS256 verifies with an RSA key`;
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return 'is an RSA key shorter than 2048 bits';
  } else if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return 'is not a P-256 key, which ES256 verifies with';
  }
  return null;
}

/** Every reason a host-assertion entry's own fields cannot be synthesized. */
function hostAssertionErrors(e: IssuerConfig, at: string): string[] {
  const errors: string[] = [];
  // NO DISCOVERY, NO AUDIENCE OF ITS OWN (the edge checks the deployment id), NO GROUPS.
  for (const f of ['pool', 'providerName', 'discoveryUrl', 'tenants', 'tokenVersion', 'audience', 'tokenType', 'groupsClaim', 'adminGroups'] as const) {
    if (e[f] !== undefined) errors.push(`${at}: a host-assertion entry declares no ${f}; its keys are pinned and its audience is this deployment`);
  }
  if (typeof e.issuer !== 'string' || !/^(https:\/\/\S+|urn:\S+)$/.test(e.issuer)) {
    errors.push(`${at}: a host-assertion entry names the exact issuer its assertions carry (an https URL or a urn)`);
  }
  if (e.tokenUse !== undefined && e.tokenUse !== 'access') errors.push(`${at}: a host assertion is presented once, at the exchange; tokenUse is "access" or absent`);
  if (e.provisioning !== undefined && e.provisioning !== 'provisioned-only') {
    errors.push(`${at}: a host-assertion issuer is provisioned-only: a subject reaches only a person provisionSubject pre-assigned`);
  }
  if (!isStringList(e.allowedOrigins) || !e.allowedOrigins.length) {
    errors.push(`${at}: a host-assertion entry lists allowedOrigins, the host origins that embed the widget`);
  }
  const h = e.hostAssertion as unknown as Record<string, unknown> | undefined;
  if (!h || typeof h !== 'object' || Array.isArray(h)) {
    errors.push(`${at}: a host-assertion entry declares hostAssertion: { publicKeys: { "<kid>": "<base64 DER public key>" } }`);
    return errors;
  }
  for (const k of Object.keys(h)) if (!HOST_ASSERTION_FIELDS.includes(k)) errors.push(`${at}: hostAssertion.${k} is not a host-assertion setting; the settings are ${HOST_ASSERTION_FIELDS.join(', ')}`);
  const keys = h.publicKeys as Record<string, unknown> | undefined;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.keys(keys).length) {
    errors.push(`${at}: hostAssertion.publicKeys pins at least one key, by kid`);
  } else {
    if (Object.keys(keys).length > 2) errors.push(`${at}: hostAssertion.publicKeys pins at most two keys: the one signing, and during a rotation the one it replaces`);
    const algorithm: SigningAlgorithm = e.algorithm === 'ES256' ? 'ES256' : 'RS256';
    for (const [kid, value] of Object.entries(keys)) {
      if (!KID.test(kid)) errors.push(`${at}: hostAssertion.publicKeys names "${kid}", which is not a key id (letters, digits, dot, dash, underscore)`);
      const why = pinnedKeyError(value, algorithm);
      if (why) errors.push(`${at}: hostAssertion.publicKeys.${kid} ${why}`);
    }
  }
  if (h.maxMinutes !== undefined && !(typeof h.maxMinutes === 'number' && Number.isInteger(h.maxMinutes) && h.maxMinutes >= 1 && h.maxMinutes <= HOST_ASSERTION_MAX_MINUTES)) {
    errors.push(`${at}: hostAssertion.maxMinutes is a whole number of minutes from 1 to ${HOST_ASSERTION_MAX_MINUTES}`);
  }
  return errors;
}

export interface IssuerConfig {
  /** The registry id: the prefix of every `Identities` key for this issuer. */
  id: string;
  kind: IssuerKind;
  /** `cognito-pool`, `cognito-federated`: `self` (this deployment's pool) or a pool id. */
  pool?: string;
  /** `cognito-federated`: the SAML or OIDC provider name configured on the pool. */
  providerName?: string;
  /** `oidc`, `host-assertion`: the exact `iss` its tokens carry. */
  issuer?: string;
  /** `oidc`, `oidc-entra`: the OpenID discovery document. */
  discoveryUrl?: string;
  /** `oidc-entra`: the tenant GUIDs whose tokens are accepted. */
  tenants?: string[];
  /** `oidc-entra`: the token version this issuer sends (1 or 2). */
  tokenVersion?: 1 | 2;
  /**
   * The audience its tokens carry for this deployment. Required for `oidc` and `oidc-entra`. For a
   * Cognito kind, the app client ids its tokens are issued to; the deployment's own pool defaults to its
   * own clients, and the edge authorizer refuses any other pool that declares none.
   */
  audience?: string | string[];
  /**
   * Which token the client presents. Default `id`. The edge authorizer refuses the other one: a Cognito
   * token by its `token_use` claim, an OIDC token by its declared token type (`tokenType`).
   */
  tokenUse?: 'id' | 'access';
  /**
   * The one algorithm this issuer signs with, `RS256` (default) or `ES256`. The edge authorizer refuses a
   * token whose header names any other, because the verifier library accepts any algorithm a key's type
   * allows and has no pin of its own.
   */
  algorithm?: SigningAlgorithm;
  /**
   * `oidc`, `oidc-entra` with `tokenUse: 'access'`: the claim and value that mark an access token, for an
   * issuer that does not send the `at+jwt` header type (RFC 9068). Absent, the header type is required.
   */
  tokenType?: { claim: string; value: string };
  /** The claims that together name a subject, uniquely and permanently. Defaults by kind. */
  subject?: string[];
  /**
   * `oidc`, `oidc-entra`: claims a token must carry with exactly these values, refused at the edge otherwise.
   * Required for an issuer whose `iss` is shared across organizations (`SHARED_ISSUERS`): Google Workspace
   * declares `{ "hd": "<its domain>" }`.
   */
  requiredClaims?: Record<string, string>;
  /** `oidc`, `oidc-entra`: the longest a token may live from `iat` to `exp`, in minutes. Default 90, at most 1440. */
  maxLifetimeMinutes?: number;
  /** Where reach comes from, and the most it can be (Q5). Required. */
  clearance: ClearanceConfig;
  /** May this issuer's people hold an admin role (A6). Default false; `self` defaults to true. */
  admin?: boolean;
  /** The group values that mark an admin, for a `groups` source. Default `admins`. */
  adminGroups?: string[];
  /** The claim the issuer's groups arrive in. Default `cognito:groups` for Cognito kinds, `groups` otherwise. */
  groupsClaim?: string;
  /** The origins a client of this issuer is served from (the widget's embed list). */
  allowedOrigins?: string[];
  /** What the sign-in screen calls this issuer, per locale. Default `{ en: <id> }`. */
  displayName?: Record<string, string>;
  /** The directory adapter a person's name and contact are read through. */
  directory?: string;
  provisioning?: string;
  /** What offboards this issuer's people. Default `cloudtrail-cognito` for a Cognito kind, else `none`. */
  lifecycle?: string;
  /** `guest`: the guest issuer's settings (`GuestIssuerSettings`). Refused on any other kind. */
  guest?: GuestIssuerSettings;
  /** `host-assertion`: its pinned keys and assertion lifetime (`HostAssertionSettings`). Refused on any other kind. */
  hostAssertion?: HostAssertionSettings;
  /** `invitation-link`: the link session and its abuse controls (`InvitationLinkSettings`). Refused on any other kind. */
  invitationLink?: InvitationLinkSettings;
}

/**
 * The registry when the deployment declares none: its own pool, its groups as clearance for whatever they clear
 * for, its admins as admins.
 */
export function defaultIssuers(_profiles?: unknown): IssuerConfig[] {
  return [{
    id: DEPLOYMENT_ISSUER_ID,
    kind: 'cognito-pool',
    pool: 'self',
    // No list: its people reach whatever their groups clear for, read at runtime (`issuerClassificationsOf`), so the
    // registry is the same whichever classifications the deployment declares. An outside one (the guest) is reached
    // through its own issuer alone, and no group clears for one.
    clearance: { groups: true },
    admin: true,
  }];
}

// ── PARSING AND REFUSAL ──────────────────────────────────────────────────────────────────────────

/**
 * The `issuers` context value as an array: an array (a test's context), its JSON string (`-c` by hand),
 * or `json64:<base64url JSON>`, which is how `deploy.mjs` forwards deploy.config.json's array so no shell
 * can split or unquote it.
 */
export function parseIssuersContext(raw: unknown): unknown[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw;
  let text = String(raw).trim();
  if (text.startsWith('json64:')) text = Buffer.from(text.slice('json64:'.length), 'base64url').toString('utf8');
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`issuers: the value is not JSON: ${text.slice(0, 80)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('issuers: the value is not a list of issuer entries');
  return parsed;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const POOL_ID = /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Profiles = Pick<ProfileRegistry, 'classificationValues' | 'isKnownClassification' | 'isConversational' | 'grantsFor'>
  & Partial<Pick<ProfileRegistry, 'memberClassificationValues' | 'outsideClassificationValues' | 'adminPlaneValues' | 'groupClearance' | 'membershipGroups'>>;

/** The kinds whose people's groups arrive on their token in the provider's own terms, and are translated. */
const TRANSLATING_KINDS: readonly IssuerKind[] = ['cognito-federated', 'oidc', 'oidc-entra'];

/** The claims a groups claim arrives in, which a `mapping` may not read: groups are translated, never mapped. */
const GROUPS_CLAIMS = new Set(['groups', 'cognito:groups', 'custom:groups']);

/** True when a `groups` source is a per-issuer translation rather than a pool's own groups. */
export function isTranslation(g: unknown): g is GroupsTranslation {
  return !!g && typeof g === 'object' && !Array.isArray(g);
}

/**
 * THE AGENTECHELON GROUPS: the deployment's own vocabulary, which every clearance, membership requirement,
 * console role and team scope is decided on. The keys of `groupClearance` and `membershipGroups`, the
 * console role groups (`admins`, `team-members`, `ADMIN_ROLE_GROUP` in lib/config/admin-capabilities.ts),
 * and the `team-<name>` groups (`TEAM_NAME_PATTERN`, lib/config/profiles.ts).
 */
export function isAgentEchelonGroup(profiles: Partial<Pick<ProfileRegistry, 'groupClearance' | 'membershipGroups'>>, group: string): boolean {
  if (group === 'admins' || group === 'team-members') return true;
  if (/^team-[a-z0-9][a-z0-9-]{0,47}$/.test(group)) return true;
  if (profiles.groupClearance && Object.prototype.hasOwnProperty.call(profiles.groupClearance, group)) return true;
  const membership = profiles.membershipGroups?.() ?? {};
  return Object.prototype.hasOwnProperty.call(membership, group);
}

/** Options the registry is checked under. */
export interface IssuerCheckOptions {
  /** The declared capability list, for L18. */
  capabilities?: readonly string[];
  /** The deployment environment (`lib/config/environment.ts`): `production` refuses test keys and a 0 limit. */
  environment?: string;
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);

/** The clearance source an entry declares, by name, or null when it declares none or several. */
export function clearanceSourceOf(c: Partial<ClearanceConfig> | undefined): 'groups' | 'mapping' | 'fixed' | 'oneChannel' | null {
  if (!c || typeof c !== 'object') return null;
  const named = (['groups', 'mapping', 'fixed', 'oneChannel'] as const).filter((k) => (c as Record<string, unknown>)[k] !== undefined);
  return named.length === 1 ? named[0] : null;
}

function entryErrors(e: IssuerConfig, profiles: Profiles, environment = 'dev'): string[] {
  const errors: string[] = [];
  const at = `issuer "${e.id}"`;
  if (!ISSUER_KINDS.includes(e.kind)) {
    return [`${at}: kind "${String(e.kind)}" is not an issuer kind; the registry knows ${ISSUER_KINDS.join(', ')}`];
  }

  // The kind's own fields.
  if (COGNITO_KINDS.includes(e.kind)) {
    if (!e.pool || (e.pool !== 'self' && !POOL_ID.test(e.pool))) errors.push(`${at}: a ${e.kind} entry names its pool, "self" or a user pool id`);
    if (e.pool === 'self' && e.kind === 'cognito-pool' && e.id !== DEPLOYMENT_ISSUER_ID) {
      errors.push(`${at}: this deployment's own pool is the issuer "${DEPLOYMENT_ISSUER_ID}"; give the entry with pool "self" that id`);
    }
    if (e.kind === 'cognito-federated' && !e.providerName) errors.push(`${at}: a cognito-federated entry names its providerName`);
  }
  if (e.kind === 'oidc') {
    if (!e.issuer || !/^https:\/\//.test(e.issuer)) errors.push(`${at}: an oidc entry names the exact https issuer its tokens carry`);
  }
  if (e.kind === 'oidc-entra') {
    if (!isStringList(e.tenants) || !e.tenants.every((t) => GUID.test(t))) errors.push(`${at}: an oidc-entra entry lists its tenant GUIDs`);
    if (e.tokenVersion !== 1 && e.tokenVersion !== 2) errors.push(`${at}: an oidc-entra entry declares tokenVersion 1 or 2`);
  }
  if (OIDC_KINDS.includes(e.kind)) {
    if (!e.discoveryUrl || !/^https:\/\//.test(e.discoveryUrl)) errors.push(`${at}: an ${e.kind} entry names its https discoveryUrl`);
    const aud = typeof e.audience === 'string' ? [e.audience] : e.audience;
    if (!isStringList(aud)) errors.push(`${at}: an ${e.kind} entry names the audience its tokens carry`);
  }
  if (COGNITO_KINDS.includes(e.kind) && e.audience !== undefined) {
    const aud = typeof e.audience === 'string' ? [e.audience] : e.audience;
    if (!isStringList(aud) || !aud.length) errors.push(`${at}: audience lists the app client ids its tokens are issued to`);
  }
  if (e.tokenUse !== undefined && e.tokenUse !== 'id' && e.tokenUse !== 'access') errors.push(`${at}: tokenUse is "id" or "access"`);
  if (e.requiredClaims !== undefined) {
    if (!OIDC_KINDS.includes(e.kind)) errors.push(`${at}: requiredClaims belong to a directly verified oidc or oidc-entra entry`);
    const rc = e.requiredClaims as unknown;
    if (!rc || typeof rc !== 'object' || Array.isArray(rc) || !Object.keys(rc).length
      || !Object.values(rc).every((v) => typeof v === 'string' && v.length > 0)) {
      errors.push(`${at}: requiredClaims maps each claim to the exact value a token must carry`);
    }
  }
  if (e.kind === 'oidc' && typeof e.issuer === 'string' && SHARED_ISSUERS.includes(e.issuer)
    && !(e.requiredClaims && Object.keys(e.requiredClaims).length)) {
    errors.push(`${at}: "${e.issuer}" is shared by every account of that provider, so any of them would sign in; declare requiredClaims naming yours (Google Workspace: { "hd": "<your domain>" })`);
  }
  if (e.maxLifetimeMinutes !== undefined) {
    if (!OIDC_KINDS.includes(e.kind)) errors.push(`${at}: maxLifetimeMinutes bounds a directly verified oidc or oidc-entra token`);
    if (!(Number.isInteger(e.maxLifetimeMinutes) && e.maxLifetimeMinutes >= 5 && e.maxLifetimeMinutes <= 1440)) {
      errors.push(`${at}: maxLifetimeMinutes is a whole number of minutes from 5 to 1440`);
    }
  }
  if (e.algorithm !== undefined && !(SIGNING_ALGORITHMS as readonly string[]).includes(e.algorithm)) {
    errors.push(`${at}: algorithm is one of ${SIGNING_ALGORITHMS.join(', ')}; none, HMAC and EdDSA are refused`);
  }
  if (e.tokenType !== undefined) {
    const t = e.tokenType as { claim?: unknown; value?: unknown } | null;
    if (!t || typeof t.claim !== 'string' || !t.claim || typeof t.value !== 'string' || !t.value) {
      errors.push(`${at}: tokenType names the claim and the value that mark an access token`);
    } else if (!OIDC_KINDS.includes(e.kind) || e.tokenUse !== 'access') {
      errors.push(`${at}: tokenType marks an OIDC access token; it is declared only with tokenUse "access" on an oidc or oidc-entra entry`);
    }
  }
  if (e.subject !== undefined && !isStringList(e.subject)) errors.push(`${at}: subject lists the claims that name a subject`);
  // A POOL IS ASKED BY ITS OWN SUBJECT. Whether an account may sign in (`Directory.accountState`), its groups
  // and its group listings are read from the pool by the account's `sub` (a federated account through the
  // username `ListUsers` finds for it), so an entry reading the `cognito` directory keys on `sub` alone. Any
  // other claim, or a composite, would find no account, and every vend through the entry would be refused.
  else if (e.subject !== undefined && COGNITO_KINDS.includes(e.kind) && directoryOf(e) === 'cognito'
    && !(e.subject.length === 1 && e.subject[0] === 'sub')) {
    errors.push(`${at}: a ${e.kind} entry is read from its pool by the account's sub; its subject is ["sub"] or absent`);
  }
  if (e.kind === 'guest') {
    // THE PLATFORM'S OWN ISSUER: no pool, no discovery, no audience of its own (the edge checks the
    // deployment id), one algorithm, and the subject guest start mints.
    for (const f of ['pool', 'providerName', 'issuer', 'discoveryUrl', 'tenants', 'tokenVersion', 'audience', 'tokenType', 'subject', 'groupsClaim', 'adminGroups'] as const) {
      if (e[f] !== undefined) errors.push(`${at}: a guest entry declares no ${f}; the platform signs its tokens itself`);
    }
    if (e.algorithm !== undefined && e.algorithm !== 'ES256') errors.push(`${at}: a guest issuer signs with ES256, the algorithm of its KMS key`);
    if (e.tokenUse !== undefined && e.tokenUse !== 'access') errors.push(`${at}: a guest token is an access token; tokenUse is "access" or absent`);
    if (e.provisioning !== undefined && e.provisioning !== 'on-first-sign-in') errors.push(`${at}: a guest is minted by guest start; provisioning is "on-first-sign-in" or absent`);
    if (e.directory !== undefined && e.directory !== 'none') errors.push(`${at}: a guest has no directory; directory is "none" or absent`);
    errors.push(...guestErrors(e, at, environment));
  } else if (e.guest !== undefined) {
    errors.push(`${at}: guest settings belong to a guest entry; a ${e.kind} entry declares none`);
  }
  if (e.kind === 'host-assertion') errors.push(...hostAssertionErrors(e, at));
  else if (e.hostAssertion !== undefined) errors.push(`${at}: hostAssertion settings belong to a host-assertion entry; a ${e.kind} entry declares none`);
  if (e.kind === 'invitation-link') errors.push(...invitationLinkErrors(e, at, environment, profiles));
  else if (e.invitationLink !== undefined) errors.push(`${at}: invitationLink settings belong to an invitation-link entry; a ${e.kind} entry declares none`);

  // THE CLEARANCE SOURCE AND THE CLASSIFICATIONS IT MAY GRANT, both required (Q5).
  const c = e.clearance as ClearanceConfig | undefined;
  const source = clearanceSourceOf(c);
  if (!c || !source) {
    errors.push(`${at}: declares no clearance source; name exactly one of groups, mapping, fixed or oneChannel, with the classifications it may grant. `
      + 'There is no fallback reach: an issuer without one reaches nothing, so synth refuses it');
  } else {
    const declared = c.classifications;
    if (declared === undefined && source === 'groups' && e.kind !== 'guest') {
      // A GROUPS SOURCE MAY LIST NONE: its people reach whatever their groups clear for (`issuerClassificationsOf`).
    } else if (!isStringList(declared) || declared.length === 0) {
      errors.push(`${at}: the clearance declares no classifications; list the classifications it may grant`);
    } else {
      for (const v of declared) if (!profiles.isKnownClassification(v)) errors.push(`${at}: classifications name "${v}", which this deployment does not declare`);
    }
    const within = (v: string) => isStringList(declared) && declared.includes(v);
    // AN OUTSIDE CLASSIFICATION IS THE GUEST'S, AND THE GUEST'S IS ONLY THAT (profiles.ts `audience`).
    const outside = profiles.outsideClassificationValues?.() ?? [];
    const visitor = visitorClassifications(outside);
    if (e.kind === 'guest') {
      const fixed = (c as { fixed?: unknown }).fixed;
      if (source !== 'fixed' || !isStringList(fixed) || fixed.length !== 1 || !visitor.includes(fixed[0])
        || !isStringList(declared) || declared.length !== 1 || declared[0] !== fixed[0]) {
        errors.push(`${at}: a guest issuer's clearance is fixed at one visitor classification and bound to it: `
          + `{ "fixed": ["<c>"], "classifications": ["<c>"] }, where <c> is one of ${visitor.join(', ') || '(none declared)'}`);
      }
    } else {
      // A VISITOR'S CLASSIFICATION IS THE GUEST ISSUER'S ALONE. Another outside one (the customer) is
      // reached by a signed-in issuer for outside people, whose classifications name nothing the deployment's
      // own people hold: one issuer never spans staff and customers. An entry that lists none is held to the
      // same rules by what it reaches with no list (`issuerClassificationsOf`).
      const r = profiles as Partial<ReachRegistry>;
      const reached = isStringList(declared) ? declared
        : declared === undefined && r.memberClassificationValues && r.adminPlaneValues
          ? issuerClassificationsOf({ clearance: c, admin: e.admin === true }, r as ReachRegistry) : [];
      for (const v of reached) {
        if (visitor.includes(v)) errors.push(`${at}: classifications name "${v}", a visitor's classification; only a guest issuer reaches it`);
      }
      const named = reached.filter((v) => outside.includes(v) && !visitor.includes(v));
      if (named.length && named.length !== reached.length) {
        errors.push(`${at}: classifications name the outside classification "${named[0]}" beside the deployment's own; `
          + 'an issuer for outside people reaches outside classifications alone');
      }
      if (named.length && e.admin === true) errors.push(`${at}: an issuer for outside people cannot declare admin: true`);
    }
    if (e.kind === 'host-assertion' && source !== 'mapping' && source !== 'fixed') {
      errors.push(`${at}: a host-assertion issuer's clearance is a mapping (its permission-set claim) or a fixed set, within its declared classifications`);
    }
    if (source === 'groups') {
      const g = (c as { groups: unknown }).groups;
      if (g === true) {
        if (e.kind !== 'cognito-pool') {
          errors.push(`${at}: groups: true is a cognito-pool's own groups; a ${e.kind} entry translates its provider's groups: `
            + '{ "groups": { "map": { "<provider group>": "<AgentEchelon group>" } } }');
        }
      } else if (!isTranslation(g)) {
        errors.push(`${at}: groups is true (a cognito-pool's own groups) or a translation { "map": { ... } }`);
      } else {
        if (!TRANSLATING_KINDS.includes(e.kind)) {
          errors.push(`${at}: a groups translation is declared by a ${TRANSLATING_KINDS.join(', ')} entry; a ${e.kind} entry declares ${e.kind === 'cognito-pool' ? 'groups: true' : 'a mapping or a fixed set'}`);
        }
        const map = (g as { map?: unknown }).map;
        if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length) {
          errors.push(`${at}: groups.map names each provider group and the AgentEchelon group it is`);
        } else {
          for (const [value, target] of Object.entries(map as Record<string, unknown>)) {
            const targets = typeof target === 'string' ? [target] : target;
            if (!isStringList(targets) || !targets.length) { errors.push(`${at}: groups.map value "${value}" names no AgentEchelon group`); continue; }
            for (const t of targets) {
              if (!isAgentEchelonGroup(profiles, t)) {
                errors.push(`${at}: groups.map value "${value}" maps to "${t}", which is not an AgentEchelon group (a groupClearance or membershipGroups key, admins, team-members or team-<name>)`);
              }
            }
          }
        }
        if (e.kind === 'cognito-federated') {
          if ((g as GroupsTranslation).emptyGroupsSent !== true) {
            errors.push(`${at}: a cognito-federated groups translation declares emptyGroupsSent: true, stating the provider sends the groups attribute even when it is empty. `
              + 'Cognito keeps a mapped value the provider stops sending, so without it a person removed from their last group keeps it');
          }
          if (e.tokenUse === 'access') errors.push(`${at}: a cognito-federated groups translation reads custom:groups, which Cognito carries on the ID token only; tokenUse is "id"`);
        } else if ((g as GroupsTranslation).emptyGroupsSent !== undefined) {
          errors.push(`${at}: emptyGroupsSent belongs to a cognito-federated translation, whose groups rest on the pool account`);
        }
        const age = (g as { recordMaxAgeDays?: unknown }).recordMaxAgeDays;
        if (age !== undefined && !(Number.isInteger(age) && (age as number) >= 1 && (age as number) <= 365)) {
          errors.push(`${at}: groups.recordMaxAgeDays is a whole number of days from 1 to 365`);
        }
      }
    }
    if (source === 'mapping') {
      const m = (c as { mapping: { claim?: unknown; values?: unknown } }).mapping;
      if (!m || typeof m.claim !== 'string' || !m.claim || !m.values || typeof m.values !== 'object') {
        errors.push(`${at}: a mapping names its claim and its values`);
      } else if (GROUPS_CLAIMS.has(m.claim) || (e.groupsClaim !== undefined && m.claim === e.groupsClaim)) {
        // ONE WAY TO TRANSLATE GROUPS (tenet D9): a mapping skips the AgentEchelon groups, so its people could
        // be cleared and never be an admin or a team member.
        errors.push(`${at}: a mapping reads "${m.claim}", a groups claim; groups are translated into AgentEchelon groups: `
          + '{ "groups": { "map": { "<provider group>": "<AgentEchelon group>" } } }');
      } else {
        for (const [value, target] of Object.entries(m.values as Record<string, unknown>)) {
          const targets = typeof target === 'string' ? [target] : target;
          if (!isStringList(targets)) { errors.push(`${at}: mapping value "${value}" maps to no classification`); continue; }
          for (const t of targets) if (!within(t)) errors.push(`${at}: mapping value "${value}" maps to "${t}", outside the issuer's classifications`);
        }
        const age = (m as { recordMaxAgeDays?: unknown }).recordMaxAgeDays;
        if (age !== undefined && !(Number.isInteger(age) && (age as number) >= 1 && (age as number) <= 365)) {
          errors.push(`${at}: mapping.recordMaxAgeDays is a whole number of days from 1 to 365`);
        }
      }
    }
    if (source === 'fixed') {
      const fixed = (c as { fixed: unknown }).fixed;
      if (!isStringList(fixed) || !fixed.length) errors.push(`${at}: fixed lists the classifications it grants`);
      else for (const v of fixed) if (!within(v)) errors.push(`${at}: fixed names "${v}", outside the issuer's classifications`);
    }
    if (source === 'oneChannel') {
      const one = (c as { oneChannel: unknown }).oneChannel;
      if (typeof one !== 'string' || !one) errors.push(`${at}: oneChannel names the classification its conversations are created at`);
      else {
        if (!within(one)) errors.push(`${at}: oneChannel names "${one}", outside the issuer's classifications`);
        if (!profiles.isConversational(one)) errors.push(`${at}: oneChannel names "${one}", which is not a classification a conversation can be created at`);
        // THE GATEWAY MUST BE A SECOND LAYER (tenet D3). This deployment's own pool is admitted on every
        // person route, so its authorizers could never refuse a one-conversation person there.
        if (e.pool === 'self') {
          errors.push(`${at}: oneChannel cannot be declared on this deployment's own pool: that pool serves every person route, `
            + 'so the gateway cannot be a second layer for a one-conversation person. A one-conversation population must be its own pool');
        }
      }
    }
  }

  // ADMIN (A6, D10).
  if (e.admin !== undefined && typeof e.admin !== 'boolean') errors.push(`${at}: admin is true or false`);
  if (e.admin === true && NEVER_ADMIN_KINDS.includes(e.kind)) {
    errors.push(`${at}: a ${e.kind} issuer cannot declare admin: true; its people are outside the deployment's staff`);
  }
  if (e.adminGroups !== undefined) {
    if (e.admin !== true) errors.push(`${at}: adminGroups is meaningful only with admin: true`);
    if (!isStringList(e.adminGroups) || !e.adminGroups.length) errors.push(`${at}: adminGroups lists the group values that mark an admin`);
    if (source !== 'groups' || (c as { groups?: unknown }).groups !== true) {
      errors.push(`${at}: adminGroups names which of a pool's own groups mark an admin; a translation marks its admins by mapping a provider group to admins`);
    }
  }
  if (e.admin === true && source === 'oneChannel') errors.push(`${at}: a oneChannel issuer cannot declare admin: true; its people reach one conversation`);

  // DESCRIPTIVE FIELDS.
  if (e.groupsClaim !== undefined && (typeof e.groupsClaim !== 'string' || !e.groupsClaim)) errors.push(`${at}: groupsClaim names a claim`);
  if (e.allowedOrigins !== undefined) {
    const literal = (o: string) => /^https:\/\/[^/\s]+$/.test(o) || /^http:\/\/localhost(:\d+)?$/.test(o);
    if (!isStringList(e.allowedOrigins) || !e.allowedOrigins.every((o) => o === WIDGET_HOST_ORIGIN || literal(o))) {
      errors.push(`${at}: allowedOrigins lists https origins (or http://localhost), each with no path, or "${WIDGET_HOST_ORIGIN}"`);
    } else if (e.allowedOrigins.includes(WIDGET_HOST_ORIGIN)) {
      if (e.kind !== 'guest') {
        errors.push(`${at}: "${WIDGET_HOST_ORIGIN}" is the sample host page a guest issuer's visitors arrive from; a ${e.kind} entry names its hosts`);
      }
      if (environment === 'production') errors.push(`${at}: "${WIDGET_HOST_ORIGIN}" is a sample page for testing the widget, refused in production`);
    }
  }
  if (e.displayName !== undefined) {
    const ok = e.displayName && typeof e.displayName === 'object'
      && Object.entries(e.displayName).every(([locale, name]) => /^[a-z]{2}(-[A-Z]{2})?$/.test(locale) && typeof name === 'string' && name.length > 0);
    if (!ok) errors.push(`${at}: displayName maps a locale (en, zh, pt-BR) to a name`);
  }
  if (e.directory !== undefined) {
    const notBuilt = typeof e.directory === 'string' ? notBuiltDirectory(e.directory) : null;
    if (notBuilt) {
      errors.push(`${at}: directory "${e.directory}" is NOT BUILT: ${notBuilt}; the built adapters are ${DIRECTORIES.join(', ')}`);
    } else if (!(DIRECTORIES as readonly string[]).includes(e.directory)) {
      errors.push(`${at}: directory "${e.directory}" is NOT BUILT; the built adapters are ${DIRECTORIES.join(', ')}`);
    } else if (e.directory === 'cognito' && !COGNITO_KINDS.includes(e.kind)) {
      errors.push(`${at}: the cognito directory reads a Cognito pool; a ${e.kind} entry declares directory "claims" or "none"`);
    } else if (e.directory === 'claims' && COGNITO_KINDS.includes(e.kind)) {
      // TENET P5: a pool is read live. A copy of its claims would be a second answer to what it holds.
      errors.push(`${at}: the claims directory is for an issuer with no directory of its own; a ${e.kind} entry reads its pool (directory "cognito")`);
    } else if (e.directory === 'none' && COGNITO_KINDS.includes(e.kind)) {
      // The vend asks a pool whether the account is still enabled (SPEC-CREDENTIAL-EXCHANGE 4b); a pool
      // read through no directory would vend a disabled account until its token expired.
      errors.push(`${at}: a ${e.kind} entry reads its pool (directory "cognito"), which is where the vend asks whether the account is enabled`);
    }
  }
  if (e.provisioning !== undefined) {
    if (!(PROVISIONING as readonly string[]).includes(e.provisioning)) errors.push(`${at}: provisioning is one of ${PROVISIONING.join(', ')}`);
    else if (NOT_BUILT_PROVISIONING[e.provisioning as Provisioning]) errors.push(`${at}: ${NOT_BUILT_PROVISIONING[e.provisioning as Provisioning]}`);
    else if (e.provisioning === 'provisioned-only') {
      // THE FIRST ADMINISTRATOR SIGNS IN THROUGH THE ONE MINTER (P-1), so this deployment's own pool mints.
      if (e.pool === 'self') errors.push(`${at}: this deployment's own pool mints its people at their first sign-in; provisioned-only is for another issuer`);
      // The one-conversation vend mints on its own path; a provisioned subject is bound on the exchange's.
      if (source === 'oneChannel') errors.push(`${at}: a oneChannel issuer mints its people at their first sign-in; provisioned-only takes a mapping, a fixed set or groups`);
    }
  }
  if (e.lifecycle !== undefined) {
    const l = String(e.lifecycle);
    if (l === 'scim' || l.startsWith('connector:')) errors.push(`${at}: lifecycle "${l}" is NOT BUILT: no ${l === 'scim' ? 'SCIM receiver' : 'connector lifecycle source'} exists`);
    else if (l !== 'cloudtrail-cognito' && l !== 'none') errors.push(`${at}: lifecycle is cloudtrail-cognito or none`);
    else if (l === 'cloudtrail-cognito' && !COGNITO_KINDS.includes(e.kind)) errors.push(`${at}: lifecycle cloudtrail-cognito reads a Cognito pool's events`);
  }
  return errors;
}

/**
 * Every reason a registry cannot be synthesized, one line each. Empty when it can.
 *
 * `capabilities` is the declared capability list, for L18: the `admin` capability needs an issuer
 * that is not the guest, and that declares `admin: true`.
 */
export function issuerErrors(raw: unknown[], profiles: Profiles, options: readonly string[] | IssuerCheckOptions = {}): string[] {
  const { capabilities = [], environment = 'dev' }: IssuerCheckOptions = Array.isArray(options) ? { capabilities: options as readonly string[] } : options as IssuerCheckOptions;
  const errors: string[] = [];
  const entries: IssuerConfig[] = [];
  raw.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`issuers[${i}]: an entry is an object`); return; }
    const e = r as IssuerConfig;
    if (typeof e.id !== 'string' || !ID.test(e.id)) { errors.push(`issuers[${i}]: id is lowercase letters, digits and dashes, starting with a letter`); return; }
    entries.push(e);
  });
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) errors.push(`issuer "${e.id}" is declared twice; a registry id names one issuer`);
    seen.add(e.id);
  }
  const pools = entries.filter((e) => e.kind === 'cognito-pool').map((e) => e.pool);
  if (new Set(pools).size !== pools.length) errors.push('a user pool is declared by two cognito-pool entries');
  for (const e of entries) errors.push(...entryErrors(e, profiles, environment));
  // ONE GUEST ISSUER: guest start signs with one key set and opens one kind of visitor conversation.
  const guests = entries.filter((e) => e.kind === 'guest');
  if (guests.length > 1) errors.push(`issuers ${guests.map((e) => `"${e.id}"`).join(' and ')} are both guest issuers; a deployment declares one`);

  // ONE INVITATION-LINK ISSUER: a link session is vended on one role, under one boundary.
  const links = entries.filter((e) => e.kind === 'invitation-link');
  if (links.length > 1) errors.push(`issuers ${links.map((e) => `"${e.id}"`).join(' and ')} are both invitation-link issuers; a deployment declares one`);
  // A TYPE THAT DECLARES `link` NEEDS A CLASSIFICATION THE ISSUER DECLARES: its link classifications and the
  // issuer's fixed set share one, or no link invitation of that type could ever be redeemed.
  const linkFixed = (links[0]?.clearance as { fixed?: unknown } | undefined)?.fixed;
  if (links[0] && isStringList(linkFixed)) {
    const reach = new Set(linkFixed);
    for (const typeKey of Object.keys(CONVERSATION_TYPES)) {
      const policy = invitationPolicyOf(typeKey);
      if (!policy?.modes.includes('link') || policy.linkClassifications.some((v) => reach.has(v))) continue;
      const declared = policy.linkClassifications.join(', ') || '(nothing)';
      errors.push(`issuer "${links[0].id}": conversation type "${typeKey}" declares link invitations up to ${declared}, `
        + `none of which this issuer declares (${[...reach].join(', ')}), so it cannot declare link`);
    }
  }

  // A TYPE THAT NARROWS BY ISSUER (T1, FR23) NAMES AT LEAST ONE ISSUER THIS REGISTRY DECLARES. A narrowing to
  // issuers none of which exist would admit nobody, which is an outage that reads as a refusal, so it is
  // refused here. A list naming some undeclared ids is a type shared across deployments, and is accepted.
  for (const typeKey of Object.keys(CONVERSATION_TYPES)) {
    const admitted = admittedIssuersOf(typeKey);
    if (admitted === null || admitted.some((id) => seen.has(id))) continue;
    errors.push(`conversation type "${typeKey}" admits only issuers ${admitted.map((id) => `"${id}"`).join(', ') || '(none)'}, `
      + 'none of which this registry declares, so it would admit nobody');
  }

  // ONE CONTEXT CLASSIFICATION. A host's context conversation lives at a deterministic channel derived
  // from the classification, so a host sharing it across issuers must find it at one value.
  const oneChannel = [...new Set(entries.map((e) => (e.clearance as { oneChannel?: string } | undefined)?.oneChannel).filter(Boolean))];
  if (oneChannel.length > 1) {
    errors.push(`oneChannel issuers name ${oneChannel.join(' and ')}: context conversations at more than one classification are NOT BUILT, so every oneChannel issuer names the same one`);
  }

  // AN APPROVAL NEEDS SOMEBODY TO APPROVE IT: the operator's action is on AdminApi, which only `admin` deploys.
  // Without it every registration would wait forever, which is an outage that reads as a queue. Checked where
  // the capability list is known (the app's own registry read, `bin/backend.ts`); a stack re-reading the
  // registry for its own entries passes none.
  const capabilitiesKnown = Array.isArray(options) || (options as IssuerCheckOptions).capabilities !== undefined;
  for (const g of guests) {
    if (capabilitiesKnown && g.guest?.registration?.approval === 'admin' && !capabilities.includes('admin')) {
      errors.push(`issuer "${g.id}": guest.registration.approval "admin" is approved from the admin console, `
        + 'so it needs the admin capability; declare admin in capabilities, or approval "none"');
    }
  }

  // L18: ADMIN NEEDS AN ISSUER THAT IS NOT THE GUEST.
  if (capabilities.includes('admin')) {
    const staff = entries.filter((e) => e.admin === true && !NEVER_ADMIN_KINDS.includes(e.kind));
    if (!staff.length) {
      errors.push('the admin capability needs an issuer that is not the guest: declare one (normally this deployment\'s own pool, '
        + `"${DEPLOYMENT_ISSUER_ID}") with admin: true, or remove admin from capabilities`);
    }
  }

  // A PROVIDER IS VERIFIED DIRECTLY OR FEDERATED INTO THE POOL, AND THE DEPLOYMENT CHOOSES
  // (SPEC-CREDENTIAL-EXCHANGE §4b): a pool is a dependency only of a deployment that declares one. The rejected
  // alternative refused a generic `oidc` entry and a single-tenant `oidc-entra` entry beside a pool, making
  // the pool the one verifier of every OIDC deployment.

  // KINDS THAT PARSE BUT ARE NOT BUILT.
  for (const e of entries) {
    const why = NOT_BUILT_KINDS[e.kind];
    if (why) errors.push(`issuer "${e.id}": ${why}`);
  }
  return errors;
}

/** A validated registry. */
export interface IssuerRegistry {
  readonly entries: readonly IssuerConfig[];
  byId(id: string): IssuerConfig | undefined;
  /** This deployment's own pool, when the registry trusts it. */
  self(): IssuerConfig | undefined;
  /**
   * Whether any entry is an issuer on this deployment's own pool (`pool: 'self'`), its own sign-in or a
   * provider federating into it. False, the deployment creates no user pool (L15).
   */
  ownsPool(): boolean;
  /** The one classification oneChannel issuers create context conversations at, or undefined. */
  contextClassification(): string | undefined;
  /** Every user pool id a token may come from: `self` resolved to `selfPoolId`, deduplicated. */
  poolIds(selfPoolId: string): string[];
  /** The other trusted pools, for names and contacts (the deployment's own pool excluded). */
  otherPoolIds(): string[];
  /** Every pool other than the deployment's own a token may come from, with the entry that names it. */
  /**
   * Every pool other than the deployment's own a token may come from, with the entry that names it, and
   * whether every entry naming it is a oneChannel issuer (its people reach one conversation and nothing else).
   */
  foreignPools(): Array<{ id: string; pool: string; oneChannelOnly: boolean; admin: boolean }>;
  /** The other pools whose lifecycle events offboard their people. */
  lifecyclePoolIds(): string[];
  /** The group values that mark an admin of this deployment's own pool, when they are not the default. */
  deploymentAdminGroups(): string[] | undefined;
  /** What the admin console's Users tab names as governing end users: `cognito`, or a federated provider. */
  identityProviderLabel(): string;
  /**
   * The SAML or OIDC providers that federate into this deployment's own pool (`cognito-federated`
   * entries on `pool: 'self'`), by the provider name configured on the pool. The chat app's client offers
   * each at the pool's managed login, beside the pool's own sign-in.
   */
  selfFederatedProviders(): string[];
  /** The ids of the entries whose directory is `claims`: the issuers a contact copy is kept for (C5). */
  claimsDirectoryIssuers(): string[];
  /** The guest issuer, when the registry declares one (`kind: 'guest'`). */
  guest(): IssuerConfig | undefined;
  /** The `host-assertion` entries. */
  hostAssertions(): IssuerConfig[];
  /** The entries whose subjects are admitted only once provisioned (`provisioned-only`, P-13). */
  provisionedOnly(): IssuerConfig[];
  /** The invitation-link issuer, when the registry declares one (`kind: 'invitation-link'`). */
  invitationLink(): IssuerConfig | undefined;
}

/**
 * Parse and validate the registry, or throw naming every reason it cannot be synthesized.
 * Absent (`undefined`) is the default registry.
 */
export function issuerRegistry(raw: unknown, profiles: Profiles, options: readonly string[] | IssuerCheckOptions = {}): IssuerRegistry {
  const list = parseIssuersContext(raw) ?? defaultIssuers(profiles);
  const errors = issuerErrors(list, profiles, options);
  if (errors.length) throw new Error(`issuers cannot be synthesized:\n  ${errors.join('\n  ')}`);
  const entries = list as IssuerConfig[];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const cognitoPools = entries.filter((e) => e.kind === 'cognito-pool');
  return {
    entries,
    byId: (id) => byId.get(id),
    self: () => byId.get(DEPLOYMENT_ISSUER_ID),
    ownsPool: () => entries.some((e) => COGNITO_KINDS.includes(e.kind) && e.pool === 'self'),
    contextClassification: () => entries.map((e) => (e.clearance as { oneChannel?: string }).oneChannel).find(Boolean),
    poolIds: (selfPoolId) => [...new Set(entries
      .filter((e) => COGNITO_KINDS.includes(e.kind))
      .map((e) => (e.pool === 'self' ? selfPoolId : e.pool!)))],
    otherPoolIds: () => cognitoPools.filter((e) => e.pool !== 'self').map((e) => e.pool!),
    foreignPools: () => {
      const seen = new Set<string>();
      return entries
        .filter((e) => COGNITO_KINDS.includes(e.kind) && e.pool !== 'self' && !seen.has(e.pool!) && seen.add(e.pool!))
        .map((e) => ({
          id: e.id,
          pool: e.pool!,
          oneChannelOnly: entries.filter((x) => COGNITO_KINDS.includes(x.kind) && x.pool === e.pool)
            .every((x) => clearanceSourceOf(x.clearance) === 'oneChannel'),
          admin: entries.some((x) => COGNITO_KINDS.includes(x.kind) && x.pool === e.pool && x.admin === true),
        }));
    },
    lifecyclePoolIds: () => cognitoPools
      .filter((e) => e.pool !== 'self' && (e.lifecycle ?? 'cloudtrail-cognito') === 'cloudtrail-cognito')
      .map((e) => e.pool!),
    deploymentAdminGroups: () => byId.get(DEPLOYMENT_ISSUER_ID)?.adminGroups,
    identityProviderLabel: () => {
      const federated = entries.find((e) => e.kind === 'cognito-federated');
      return federated ? (federated.displayName?.en || federated.providerName || federated.id) : 'cognito';
    },
    selfFederatedProviders: () => [...new Set(entries
      .filter((e) => e.kind === 'cognito-federated' && e.pool === 'self' && e.providerName)
      .map((e) => e.providerName!))],
    claimsDirectoryIssuers: () => entries.filter((e) => directoryOf(e) === 'claims').map((e) => e.id),
    guest: () => entries.find((e) => e.kind === 'guest'),
    hostAssertions: () => entries.filter((e) => e.kind === 'host-assertion'),
    provisionedOnly: () => entries.filter((e) => isProvisionedOnly(e)),
    invitationLink: () => entries.find((e) => e.kind === 'invitation-link'),
  };
}

// ── THE RUNTIME FORM, AND READING A TOKEN AGAINST IT ─────────────────────────────────────────────

/**
 * What a Lambda needs of one entry, written to `TRUSTED_ISSUERS` at synth. The pool is resolved, so
 * `iss` is concrete; nothing descriptive travels.
 */
export interface TrustedIssuer {
  id: string;
  kind: IssuerKind;
  /** Cognito kinds: the pool id. */
  pool?: string;
  /** Cognito kinds and `oidc`: the exact `iss`. */
  iss?: string;
  providerName?: string;
  tenants?: string[];
  tokenVersion?: 1 | 2;
  subject: string[];
  clearance: ClearanceConfig;
  admin: boolean;
  adminGroups?: string[];
  groupsClaim: string;
  /** The directory adapter the person's name, contact and groups are read through (C5). */
  directory: DirectoryAdapter;
  /** Present only for `provisioned-only`: the exchange binds a pre-assigned subject and mints nobody (P-13). */
  provisioning?: 'provisioned-only';
}

/** The issuer a Cognito pool's tokens carry. A pool id carries its region before the `_`. */
export function cognitoPoolIssuer(poolId: string, region?: string): string {
  return `https://cognito-idp.${region || poolId.split('_')[0]}.amazonaws.com/${poolId}`;
}

/**
 * The subject claims a kind declares when an entry names none. A host assertion names its person by the
 * host's own two ids, the org and the user (`org`, `sub`), so a user id is never read across two orgs.
 */
export function defaultSubject(kind: IssuerKind): string[] {
  return kind === 'oidc-entra' ? ['tid', 'oid'] : kind === 'host-assertion' ? ['org', 'sub'] : ['sub'];
}

/**
 * The runtime form of a registry. `selfPoolId` and `region` resolve `pool: 'self'`; both may be CDK
 * tokens, since the result is written with `Stack.toJsonString`.
 */
export function runtimeIssuers(registry: IssuerRegistry, selfPoolId: string, region: string, deploymentId = ''): TrustedIssuer[] {
  return registry.entries.map((e) => {
    const pool = e.pool === 'self' ? selfPoolId : e.pool;
    const iss = COGNITO_KINDS.includes(e.kind)
      ? cognitoPoolIssuer(pool!, e.pool === 'self' ? region : undefined)
      : e.kind === 'oidc' || e.kind === 'host-assertion' ? e.issuer
        : e.kind === 'guest' && deploymentId ? guestIssuerUri(deploymentId, e.id) : undefined;
    return {
      id: e.id,
      kind: e.kind,
      ...(pool ? { pool } : {}),
      ...(iss ? { iss } : {}),
      ...(e.providerName ? { providerName: e.providerName } : {}),
      ...(e.tenants ? { tenants: e.tenants } : {}),
      ...(e.tokenVersion ? { tokenVersion: e.tokenVersion } : {}),
      subject: e.subject ?? defaultSubject(e.kind),
      clearance: e.clearance,
      admin: e.admin === true,
      ...(e.adminGroups ? { adminGroups: e.adminGroups } : {}),
      groupsClaim: e.groupsClaim ?? defaultGroupsClaim(e.kind, e.clearance),
      directory: directoryOf(e),
      ...(isProvisionedOnly(e) ? { provisioning: 'provisioned-only' as const } : {}),
    };
  });
}

/**
 * Where an entry's groups arrive by default: a pool's own groups in `cognito:groups`; a provider's groups,
 * mapped into the pool by a `cognito-federated` entry's attribute mapping, in `custom:groups`; any other
 * provider's in `groups`.
 */
const defaultGroupsClaim = (kind: IssuerKind, clearance?: Partial<ClearanceConfig>): string => {
  if (kind === 'cognito-federated' && clearance && 'groups' in clearance && isTranslation(clearance.groups)) return 'custom:groups';
  return COGNITO_KINDS.includes(kind) ? 'cognito:groups' : 'groups';
};

/**
 * THE RUNTIME FORM AS IT TRAVELS, every default left out. A Lambda's environment is 4 KB in all, and a
 * router's is close to it, so what the loader can derive is not written: a Cognito entry's `iss` (from
 * its pool id), the default subject and groups claim, and `admin: false`. `expandIssuer` restores them.
 */
export function compactIssuers(issuers: readonly TrustedIssuer[]): Array<Partial<TrustedIssuer> & { id: string; kind: IssuerKind }> {
  return issuers.map((t) => {
    const out: Partial<TrustedIssuer> & { id: string; kind: IssuerKind } = { ...t };
    if (COGNITO_KINDS.includes(t.kind) && t.pool) delete out.iss;
    if (JSON.stringify(t.subject) === JSON.stringify(defaultSubject(t.kind))) delete out.subject;
    if (t.groupsClaim === defaultGroupsClaim(t.kind, t.clearance)) delete out.groupsClaim;
    if (!t.admin) delete out.admin;
    if (t.directory === directoryOf({ kind: t.kind })) delete out.directory;
    return out;
  });
}

/** One entry of the travelling form, with every default restored. Null for one that is not an entry. */
export function expandIssuer(raw: unknown): TrustedIssuer | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<TrustedIssuer>;
  if (typeof t.id !== 'string' || !t.id || !t.kind || !ISSUER_KINDS.includes(t.kind) || !t.clearance) return null;
  return {
    ...t,
    id: t.id,
    kind: t.kind,
    ...(t.iss ? { iss: t.iss } : COGNITO_KINDS.includes(t.kind) && t.pool ? { iss: cognitoPoolIssuer(t.pool) } : {}),
    subject: Array.isArray(t.subject) && t.subject.length ? t.subject : defaultSubject(t.kind),
    clearance: t.clearance,
    admin: t.admin === true,
    groupsClaim: t.groupsClaim || defaultGroupsClaim(t.kind, t.clearance),
    directory: directoryOf({ kind: t.kind, directory: t.directory }),
    ...(t.kind === 'host-assertion' || t.provisioning === 'provisioned-only' ? { provisioning: 'provisioned-only' as const } : {}),
  };
}

/**
 * A claim's values as a list. Three shapes are real: a JSON array (when the authorizer rehydrates it),
 * a comma-separated string, and a bracketed, space-separated string (`"[admins premium]"`, how API
 * Gateway serializes a multi-valued claim). Values never contain whitespace, so the split is unambiguous.
 */
export function claimValues(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((g) => String(g).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .replace(/^\[|\]$/g, '')
      .split(/[\s,]+/)
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}

type Claims = Record<string, unknown>;

/** The provider names a Cognito ID token's `identities` claim carries (a federated pool user). */
function federatedProviders(claims: Claims): string[] {
  let raw = claims.identities;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return list.map((i) => (i && typeof i === 'object' ? String((i as { providerName?: unknown }).providerName || '') : '')).filter(Boolean);
}

/**
 * THE ENTRY A TOKEN'S CLAIMS COME FROM, or null.
 *
 * `iss` is matched exactly (Entra: its template, with a tenant on the allowlist and `tid` agreeing). A
 * token naming an issuer the registry does not declare matches nothing. A Cognito pool user who signed
 * in through a provider on the pool carries an `identities` claim; it matches the `cognito-federated`
 * entry declaring that provider and never the pool's own entry, so a provider nobody declared reaches
 * nothing.
 */
export function issuerForClaims(issuers: readonly TrustedIssuer[], claims: Claims): TrustedIssuer | null {
  const iss = typeof claims.iss === 'string' ? claims.iss : '';
  if (!iss) return null;
  const providers = federatedProviders(claims);
  for (const t of issuers) {
    if (t.kind === 'cognito-pool' && t.iss === iss && providers.length === 0) return t;
    if (t.kind === 'cognito-federated' && t.iss === iss && t.providerName && providers.includes(t.providerName)) return t;
    if (t.kind === 'oidc' && t.iss === iss) return t;
    if (t.kind === 'guest' && t.iss === iss) return t;
    if (t.kind === 'host-assertion' && t.iss === iss) return t;
    if (t.kind === 'oidc-entra') {
      const tid = typeof claims.tid === 'string' ? claims.tid : '';
      if (!tid || !t.tenants?.includes(tid)) continue;
      const expected = t.tokenVersion === 1 ? `https://sts.windows.net/${tid}/` : `https://login.microsoftonline.com/${tid}/v2.0`;
      if (iss === expected) return t;
    }
  }
  return null;
}

/** The subject the entry declares, read from the claims, or null when any declared claim is missing. */
export function subjectOf(issuer: TrustedIssuer, claims: Claims): string | null {
  const parts = issuer.subject.map((c) => claims[c]);
  if (!parts.length || parts.some((p) => typeof p !== 'string' || !p)) return null;
  return (parts as string[]).join(':');
}

/**
 * THE AGENTECHELON GROUPS this token's person holds, or `[]` for an issuer whose clearance is not groups.
 * A pool's own groups are AgentEchelon groups as they stand; a provider's are translated through the
 * entry's map, and a provider group it does not name is dropped. Every clearance, console role and team
 * scope reads this, so no raw provider group reaches a decision.
 */
export function groupsOf(issuer: TrustedIssuer, claims: Claims): string[] {
  const c = issuer.clearance;
  if (!('groups' in c)) return [];
  if (!isTranslation(c.groups)) return claimValues(claims[issuer.groupsClaim]);
  return translatedGroups(c.groups, providerGroupsOf(issuer, claims));
}

/** The AgentEchelon groups a translation names for these provider groups. */
export function translatedGroups(t: GroupsTranslation, providerGroups: readonly string[]): string[] {
  return [...new Set(providerGroups.flatMap((v) => {
    const target = Object.prototype.hasOwnProperty.call(t.map, v) ? t.map[v] : undefined;
    return target === undefined ? [] : typeof target === 'string' ? [target] : target;
  }))];
}

/**
 * THE PROVIDER'S GROUPS ON THIS TOKEN, as whole values, in the provider's own terms. An array is its
 * values; a string is one value and is never split, so a group named "Not admins" stays one group (unlike
 * `claimValues`, which is for a pool's own groups, whose names carry no whitespace). Nothing at all for:
 * - an Entra group overage marker (`_claim_names.groups`, `hasgroups`): the token does not carry the groups;
 * - a `cognito-federated` token that is not an ID token or whose `identities` does not name the entry's
 *   provider: `custom:groups` is read from the provider's own sign-ins alone, never a local account's.
 * A `cognito-federated` entry's `custom:groups` is Cognito's flattened form (`decodeFlattenedAttribute`).
 */
export function providerGroupsOf(issuer: TrustedIssuer, claims: Claims): string[] {
  const names = claims._claim_names;
  if (claims.hasgroups === true || claims.hasgroups === 'true'
    || (names && typeof names === 'object' && Object.prototype.hasOwnProperty.call(names, issuer.groupsClaim))) return [];
  const raw = claims[issuer.groupsClaim];
  if (issuer.kind === 'cognito-federated') {
    if (claims.token_use !== 'id' || !issuer.providerName || !federatedProviders(claims).includes(issuer.providerName)) return [];
    return typeof raw === 'string' ? decodeFlattenedAttribute(raw) : [];
  }
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return typeof raw === 'string' && raw.length > 0 ? [raw] : [];
}

/**
 * A multi-valued attribute as Cognito writes it into a pool attribute: the values in square brackets,
 * comma-separated, each URL form-encoded except for `.`, `-`, `*` and `_` ("Mapping IdP attributes to
 * profiles and tokens", Amazon Cognito Developer Guide). A single value arrives as itself. Each value is
 * decoded after the split, so a comma or space inside a group name survives; a value that does not decode
 * reaches nothing.
 */
export function decodeFlattenedAttribute(raw: string): string[] {
  const body = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!body) return [];
  const out: string[] = [];
  for (const part of body.split(',')) {
    try {
      const v = decodeURIComponent(part.trim().replace(/\+/g, ' '));
      if (v) out.push(v);
    } catch { /* not form-encoded as Cognito writes it: reaches nothing */ }
  }
  return out;
}

/** True for the platform's own guest issuer, whose people are vended their own one conversation. */
export function isGuestIssuer(issuer: Pick<TrustedIssuer, 'kind'> | null | undefined): boolean {
  return issuer?.kind === 'guest';
}

/** The classification a oneChannel issuer's people reach their one conversation at, or null. */
export function oneChannelOf(issuer: TrustedIssuer | null | undefined): string | null {
  return issuer && 'oneChannel' in issuer.clearance ? issuer.clearance.oneChannel : null;
}

type ReachProfiles = Pick<ProfileRegistry, 'grantsFor' | 'clearancesForGroups' | 'holderOf'> & ReachRegistry;

/**
 * THE ONE TOKEN this token's person is vended at, or undefined.
 *
 * The classifications the source names (groups through the profile registry, a mapping's declared
 * values, a fixed set) are each kept only when everything they grant sits inside the issuer's classifications, and the
 * declared classification standing for exactly what remains is the token. A oneChannel issuer has no
 * token: its people are vended one conversation, never a classification.
 */
export function holderTokenOf(issuer: TrustedIssuer, claims: Claims, profiles: ReachProfiles): string | undefined {
  return holderOfClaims(issuer, claims, profiles).token;
}

/**
 * THE HOLDER this token's person is vended as: the member token (`holderTokenOf`) and whether the admin plane
 * is held beside it (`ProfileRegistry.holderOf`). A oneChannel issuer's people hold neither.
 */
export function holderOfClaims(issuer: TrustedIssuer, claims: Claims, profiles: ReachProfiles): Holder {
  const c = issuer.clearance;
  if ('oneChannel' in c) return { token: undefined, adminPlane: false };
  return profiles.holderOf(heldWithinIssuer(issuer, heldFromClaims(issuer, claims, profiles), profiles));
}

/**
 * The classifications a token's claims name through the issuer's source, before its classifications apply: groups
 * through the profile registry, a mapping's declared values (an undeclared value names nothing), a fixed
 * set, or the oneChannel classification.
 */
export function heldFromClaims(issuer: TrustedIssuer, claims: Claims, profiles: Pick<ProfileRegistry, 'clearancesForGroups'>): string[] {
  const c = issuer.clearance;
  if ('groups' in c) return profiles.clearancesForGroups(groupsOf(issuer, claims));
  if ('mapping' in c) return mappedValues(c.mapping, claimValues(claims[c.mapping.claim]));
  if ('fixed' in c) return [...c.fixed];
  return [c.oneChannel];
}

/**
 * What an issuer's rule matched on a token, for the record the exchange keeps of its decision
 * (`clearanceDecision`): the source, a mapping's claim, and the values that mapped (a mapping's declared
 * values present on the token, the groups, or the fixed set). Null for a oneChannel issuer, which is vended
 * on its own path.
 */
export function clearanceBasisOf(issuer: TrustedIssuer, claims: Claims): { source: 'groups' | 'mapping' | 'fixed'; claim?: string; matched: string[] } | null {
  const c = issuer.clearance;
  if ('groups' in c) {
    if (!isTranslation(c.groups)) return { source: 'groups', matched: groupsOf(issuer, claims) };
    const t = c.groups;
    const matched = providerGroupsOf(issuer, claims).filter((v) => Object.prototype.hasOwnProperty.call(t.map, v));
    return { source: 'groups', claim: issuer.groupsClaim, matched };
  }
  if ('mapping' in c) {
    const declared = claimValues(claims[c.mapping.claim]).filter((v) => Object.prototype.hasOwnProperty.call(c.mapping.values, v));
    return { source: 'mapping', claim: c.mapping.claim, matched: declared };
  }
  if ('fixed' in c) return { source: 'fixed', matched: [...c.fixed] };
  return null;
}

/** The classifications a mapping's declared values name. A value the mapping does not declare names nothing. */
export function mappedValues(mapping: { values: Record<string, string | string[]> }, values: readonly string[]): string[] {
  return values.flatMap((v) => {
    const target = Object.prototype.hasOwnProperty.call(mapping.values, v) ? mapping.values[v] : undefined;
    return target === undefined ? [] : typeof target === 'string' ? [target] : target;
  });
}

/**
 * THE ISSUER'S CLASSIFICATIONS BIND WHATEVER THE SOURCE SAYS: a held classification is kept only when everything it
 * grants sits inside the issuer's classifications. The one rule the token-time path (`holderTokenOf`) and the
 * offline path (`Directory.clearanceOf`, lambda/src/lib/membership-source.ts) both apply.
 */
export function heldWithinIssuer(e: ReachEntry, held: readonly string[], profiles: Pick<ProfileRegistry, 'grantsFor'> & ReachRegistry): string[] {
  const declared = new Set(issuerClassificationsOf(e, profiles));
  return [...new Set(held)].filter((v) => profiles.grantsFor(v).every((g) => declared.has(g)));
}

// ── THE PROFILE STORE BESIDE THE REGISTRY (C6) ───────────────────────────────────────────────────

const LAMBDA_ARN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}(:[A-Za-z0-9_$-]+)?$/;

/**
 * The `userProfileService` context value: the ARN of a Lambda that serves the per-person profile in place
 * of the built-in table (SPEC-USER-PROFILE-AND-ONBOARDING), or undefined when the deployment keeps the
 * table. Data, not a switch: declaring it sets `USER_PROFILE_SERVICE_ARN` on the router and grants it the
 * invoke, with no code change. A value that is not a Lambda function ARN is refused at synth.
 */
export function userProfileServiceArn(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const arn = String(raw).trim();
  if (!LAMBDA_ARN.test(arn)) {
    throw new Error(`userProfileService: "${arn.slice(0, 120)}" is not a Lambda function ARN (arn:aws:lambda:<region>:<account>:function:<name>)`);
  }
  return arn;
}
