/**
 * THE CONNECTOR REGISTRY: which external vendors a deployment integrates with, and what each one may do.
 *
 * A **connector** is one integration to one external vendor (PagerDuty, Salesforce), declared as data in
 * `deploy.config.json` (`connectors`) beside the `connectors` capability. It is broad per vendor: one
 * connector may resolve participants, receive the vendor's events and act for a person, and the runtime
 * consumes those generically from the entry, never through a `switch (vendor)` in a handler. Adding a
 * connector of a built vendor is one entry here and one secret; adding a vendor is one vendor definition
 * below and one adapter in `lambda/src/lib/connectors/`.
 *
 * ── A CONNECTOR NAMES A PERSON AND NEVER AUTHENTICATES ONE (K1, K2) ──────────────────────────────
 *
 * Every human authenticates through a registry issuer (`lib/config/issuers.ts`). A connector only resolves
 * and reads. A person a vendor names is reached through `Identities` (`<namespace>|<vendor user id>`) and
 * never by an email address: the vendor adapters do not read one. The namespace is `personIssuer`, the
 * registry issuer whose declared subject IS the vendor's immutable user id (the same single sign-on, V8),
 * or the connector's own id, for a row the person adds for their vendor account from a session already
 * pinned to them (P-13). A person with neither is reached by an invitation (M-10); a connector issuing one
 * is **NOT BUILT**, so such a person is recorded as unresolved and nothing more.
 *
 * ── ADMISSION IS THE NARROWER OF TWO LIMITS (K4) ─────────────────────────────────────────────────
 *
 * A connector that receives events declares the `classification` of the conversations those events
 * concern. A person it resolves is admitted only when what they hold reaches that classification, read
 * through their issuers' clearance sources, each within its issuer's classifications (`Directory.clearanceOf`).
 * Synth refuses a connector whose `personIssuer` classifications cannot reach its classification at all.
 *
 * ── VENDOR EVENTS ARRIVE THROUGH THE VENDOR'S EVENTBRIDGE PARTNER EVENT SOURCE (K5) ─────────────
 *
 * A connector that `subscribes` to vendor events declares its `eventSource`, the full name of the Amazon
 * EventBridge partner event source the vendor created in this account (Salesforce Event Relay,
 * `aws.partner/salesforce.com/<org id>/<relay id>`; PagerDuty's EventBridge integration,
 * `aws.partner/pagerduty.com/<subdomain>-<name>`). The partner event bus of that source carries one rule
 * per connector, pinned to the declared source and the subscribed events, whose one target is the
 * receiver. No vendor reaches an HTTP route: there is no webhook, no unauthenticated vendor route and no
 * signing secret, because EventBridge delivers only what the vendor's own partner integration put on the
 * bus. Each event is still recorded by its vendor event id, so a replay is dropped.
 *
 * `IngressApi`, an HTTP API for a vendor with no EventBridge integration (Twilio, Phase 8), is **NOT BUILT**.
 *
 * ── PER-PERSON GRANTS (K3) ───────────────────────────────────────────────────────────────────────
 *
 * A connector that declares `grants` may act for a person through that person's own OAuth grant, so the
 * vendor's sharing rules apply. Grants are kept in a KMS-encrypted table keyed by person id, revocable by
 * the person, and revoked at the vendor during offboarding.
 *
 * ── SECRETS ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Never inline and never shared across connectors. A connector that takes per-person grants reads one
 * Secrets Manager secret the operator creates (so a teardown never deletes a vendor credential):
 * `<instance>/connector/<id>/oauth-client` (`clientId`, `clientSecret`). Each function is granted only the
 * secrets of the connectors it serves. Receiving events needs no secret: the partner event source is the
 * vendor's authenticated channel into this account.
 */

// ── THE OPEN KEY SETS ───────────────────────────────────────────────────────────────────────────

/** Vendor key. Open, so a vendor added later is not a type change; synth refuses one not built. */
export type ConnectorVendor = 'pagerduty' | 'salesforce' | (string & {});

/**
 * What a connector does. Open, and a consumer ignores one it does not know.
 *  - `resolveParticipant`: a person the vendor names (an assignee, a record owner) is resolved to an
 *    AppInstanceUser through `Identities`.
 *  - `ingest`: the vendor's events arrive through its EventBridge partner event source.
 *  - `actForPerson`: the connector reads as a person, through their own grant.
 *  - `lookupRole`: who holds a role the vendor keeps (who is on call, a record's owner), for a participant role's
 *    `resolveVia` source (DESIGN-CONVERSATION-TYPES section 6.1). No vendor adapter implements it, so a connector
 *    entry declaring it is refused, and so is a `resolveVia` source; **NOT BUILT**.
 *  - `syncRecord`, `fetchContext`, `provideComms`: declared by conversation types; **NOT BUILT**.
 */
export type ConnectorCapability =
  | 'resolveParticipant'
  | 'ingest'
  | 'actForPerson'
  | 'lookupRole'
  | 'syncRecord'
  | 'fetchContext'
  | 'provideComms'
  | (string & {});

/** A conversation TYPE's reference to a connector, and which of its capabilities that type relies on. */
export interface ConnectorRef {
  connectorId: string;
  use?: ConnectorCapability[];
}

/** A conversation INSTANCE's binding to one external record (an incident, a lead), by reference. */
export interface ExternalRef {
  connectorId: string;
  system: ConnectorVendor;
  recordId: string;
  url?: string;
}

// ── THE VENDORS ─────────────────────────────────────────────────────────────────────────────────

/** A vendor's OAuth endpoints for a per-person grant. `{base}` is the connector's `loginUrl`. */
export interface GrantEndpoints {
  tokenUrl: string;
  revokeUrl: string;
  /** How the revoke call authenticates: the client credentials in the form, or the token alone. */
  revokeAuth: 'client-credentials' | 'token-only';
  /** Default for `loginUrl`, when the endpoints are templated on it. */
  defaultLoginUrl?: string;
}

/**
 * How a vendor's events reach EventBridge: the partner event source it creates, and how an event type a
 * connector subscribes to appears in the event, so the rule can match exactly the subscribed events.
 */
export interface VendorEventSource {
  /** The partner event source name prefix the vendor owns: `aws.partner/<vendor domain>/`. */
  prefix: string;
  /** The whole name, prefix included. A declared `eventSource` that does not match is refused at synth. */
  pattern: RegExp;
  /** The shape of the name, for the refusal. */
  shape: string;
  /**
   * Where the subscribed event type is in the event:
   *  - `detail-type`: the event's `detail-type` is the type (Salesforce: the Platform Event or Change Data
   *    Capture channel's API name);
   *  - `detail.event`: every event has the one `detail-type` below and the type is `detail.event` (PagerDuty).
   */
  typeAt: 'detail-type' | 'detail.event';
  /** With `typeAt: 'detail.event'`: the one `detail-type` the vendor sends. */
  detailType?: string;
}

export interface VendorDefinition {
  vendor: ConnectorVendor;
  summary: string;
  /** The capabilities this vendor's adapter implements. */
  capabilities: readonly ConnectorCapability[];
  /** The partner event source its events arrive through. */
  eventSource: VendorEventSource;
  /**
   * The vendor event types a connector of this vendor may subscribe to: a fixed list, or, for a vendor
   * whose event types are the customer's own channels (Salesforce), the shape every one of them has.
   */
  events: readonly string[] | { pattern: RegExp; shape: string };
  /** How a person the vendor names becomes a subject, for the `Identities` key. */
  subject: string;
  grants?: GrantEndpoints;
}

/** The vendors that are built: an adapter exists for each in `lambda/src/lib/connectors/`. */
export const VENDORS: Readonly<Record<'pagerduty' | 'salesforce', VendorDefinition>> = {
  pagerduty: {
    vendor: 'pagerduty',
    summary: 'On-call and incidents: an incident event names its assignees, each resolved through Identities',
    capabilities: ['resolveParticipant', 'ingest', 'actForPerson'],
    // PagerDuty's Amazon EventBridge integration (a service extension): every event has the detail-type
    // `PagerDuty Webhook`, and its detail is the webhook message, whose `event` is the type.
    eventSource: {
      prefix: 'aws.partner/pagerduty.com/',
      pattern: /^aws\.partner\/pagerduty\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/,
      shape: 'aws.partner/pagerduty.com/<subdomain>-<event source name>',
      typeAt: 'detail.event',
      detailType: 'PagerDuty Webhook',
    },
    events: [
      'incident.trigger',
      'incident.acknowledge',
      'incident.unacknowledge',
      'incident.resolve',
      'incident.assign',
      'incident.escalate',
      'incident.delegate',
      'incident.annotate',
    ],
    subject: 'the PagerDuty user id (`P...`) of each assignee',
    grants: {
      tokenUrl: 'https://identity.pagerduty.com/oauth/token',
      revokeUrl: 'https://identity.pagerduty.com/oauth/revoke',
      revokeAuth: 'client-credentials',
    },
  },
  salesforce: {
    vendor: 'salesforce',
    summary: 'Leads and cases: a record event names its owner by org and user id, resolved through Identities (V8)',
    capabilities: ['resolveParticipant', 'ingest', 'actForPerson'],
    // Salesforce Event Relay: the source names the org and the relay, and the detail-type is the API name
    // of the relayed channel's event, a Platform Event (`Lead_Assigned__e`) or a Change Data Capture event
    // (`LeadChangeEvent`, `Invoice__ChangeEvent`).
    eventSource: {
      prefix: 'aws.partner/salesforce.com/',
      pattern: /^aws\.partner\/salesforce\.com\/00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/,
      shape: 'aws.partner/salesforce.com/<organization id, 00D...>/<event relay id>',
      typeAt: 'detail-type',
    },
    events: {
      pattern: /^[A-Za-z][A-Za-z0-9_]{0,79}(?:__e|ChangeEvent)$/,
      shape: 'the API name of a Platform Event (`<Name>__e`) or a Change Data Capture event (`<Object>ChangeEvent`, `<Object>__ChangeEvent`)',
    },
    subject: '`<organizationId>:<userId>` of the record owner, the subject a Salesforce-signed sign-in carries',
    grants: {
      tokenUrl: '{base}/services/oauth2/token',
      revokeUrl: '{base}/services/oauth2/revoke',
      revokeAuth: 'token-only',
      defaultLoginUrl: 'https://login.salesforce.com',
    },
  },
};

/** Vendors the registry recognizes and synth refuses, each with why. */
export const NOT_BUILT_VENDORS: Readonly<Record<string, string>> = {
  twilio: 'the Twilio connector is NOT BUILT (telephony is a later phase)',
  servicenow: 'the ServiceNow connector is NOT BUILT',
  'aws-support': 'the AWS Support connector is NOT BUILT',
  'jira-servicedesk': 'the Jira Service Management connector is NOT BUILT',
  servicetitan: 'the ServiceTitan connector is NOT BUILT',
};

/** Capabilities an entry may declare that no adapter performs yet. */
const NOT_BUILT_CAPABILITIES: Readonly<Record<string, string>> = {
  syncRecord: 'syncRecord is NOT BUILT: no connector writes a vendor record',
  fetchContext: 'fetchContext is NOT BUILT: no connector reads into a conversation',
  provideComms: 'provideComms is NOT BUILT: no connector supplies a transport',
};

// ── THE ENTRY ───────────────────────────────────────────────────────────────────────────────────

export interface ConnectorConfig {
  /** Registry id: the receiving rule's name, the secret's name and the `Identities` namespace. */
  id: string;
  vendor: ConnectorVendor;
  /** What this deployment uses it for. Default: every capability its vendor implements. */
  capabilities?: ConnectorCapability[];
  /** The vendor event types it receives (K5). Absent: no rule, and no receiver for it. */
  subscribes?: string[];
  /**
   * Required with `subscribes`: the full name of the vendor's EventBridge partner event source, which is
   * also the name of the partner event bus it is associated with (`aws.partner/salesforce.com/<org>/<relay>`,
   * `aws.partner/pagerduty.com/<subdomain>-<name>`). The rule matches this source and nothing else.
   */
  eventSource?: string;
  /** The classification of the conversations its events concern; every person it names is admitted against it (K4). */
  classification?: string;
  /** The registry issuer whose declared subject is this vendor's user id (V8). Absent: the connector's own namespace. */
  personIssuer?: string;
  /** Per-person grants (K3): the redirect URIs a client may complete the vendor's authorization on. */
  grants?: { redirectUris: string[]; scopes?: string[] };
  /** Salesforce: the org's login URL (`https://<my-domain>.my.salesforce.com`). Default `https://login.salesforce.com`. */
  loginUrl?: string;
}

/** What a Lambda needs of one entry, written to `CONNECTORS` at synth. */
export interface RuntimeConnector {
  id: string;
  vendor: 'pagerduty' | 'salesforce';
  capabilities: ConnectorCapability[];
  subscribes: string[];
  /** The partner event source its events arrive from; the receiver refuses an event from any other. */
  eventSource?: string;
  classification?: string;
  /** The `Identities` namespace a vendor user id is looked up under: `personIssuer`, else the connector id. */
  namespace: string;
  grants?: { redirectUris: string[]; scopes: string[]; tokenUrl: string; revokeUrl: string; revokeAuth: GrantEndpoints['revokeAuth'] };
}

// ── PARSING AND REFUSAL ─────────────────────────────────────────────────────────────────────────

/**
 * The `connectors` context value as an array: an array (a test's context), its JSON string, or
 * `json64:<base64url JSON>`, which is how `deploy.mjs` forwards a structured value.
 */
export function parseConnectorsContext(raw: unknown): unknown[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw;
  let text = String(raw).trim();
  if (text.startsWith('json64:')) text = Buffer.from(text.slice('json64:'.length), 'base64url').toString('utf8');
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`connectors: the value is not JSON: ${text.slice(0, 80)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('connectors: the value is not a list of connector entries');
  return parsed;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);

/** What the registry checks an entry against: the issuers and classifications this deployment declares. */
export interface ConnectorContext {
  /** Each registry issuer, by id, with its classifications. */
  issuers: ReadonlyArray<{ id: string; classifications: readonly string[] }>;
  isConversational(classification: string): boolean;
  /** The classifications a held classification grants. */
  grantsFor(classification: string): readonly string[];
}

function redirectUriError(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return null;
  return 'is neither https nor a localhost address';
}

/** Whether the vendor sends an event of this type. */
export function sendsEvent(def: VendorDefinition, type: string): boolean {
  return Array.isArray(def.events) ? def.events.includes(type) : (def.events as { pattern: RegExp }).pattern.test(type);
}

function eventsShape(def: VendorDefinition): string {
  return Array.isArray(def.events) ? def.events.join(', ') : (def.events as { shape: string }).shape;
}

/** Every reason one entry cannot be synthesized. */
function entryErrors(raw: unknown, index: number, ctx: ConnectorContext, seen: Set<string>, seenSources: Set<string>): string[] {
  const errors: string[] = [];
  const e = raw as Partial<ConnectorConfig> & Record<string, unknown>;
  const at = `connectors[${index}]${typeof e?.id === 'string' ? ` (${e.id})` : ''}`;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [`${at}: is not an entry`];

  if (typeof e.id !== 'string' || !ID.test(e.id)) errors.push(`${at}: id is lowercase letters, digits and hyphens, starting with a letter, at most 32`);
  else if (seen.has(e.id)) errors.push(`${at}: the id is declared twice`);
  else seen.add(e.id);
  if (typeof e.id === 'string' && ctx.issuers.some((i) => i.id === e.id)) {
    errors.push(`${at}: the id is also an issuer's id, and the two would share an Identities namespace`);
  }

  if (e.vendor === undefined || e.vendor === '') {
    errors.push(`${at}: declares no vendor; name one of ${Object.keys(VENDORS).join(', ')}`);
    return errors;
  }
  const vendor = String(e.vendor);
  if (NOT_BUILT_VENDORS[vendor]) {
    errors.push(`${at}: vendor "${vendor}" cannot be declared: ${NOT_BUILT_VENDORS[vendor]}`);
    return errors;
  }
  const def = (VENDORS as Record<string, VendorDefinition>)[vendor];
  if (!def) {
    errors.push(`${at}: vendor "${vendor}" is not a connector vendor; the registry builds ${Object.keys(VENDORS).join(', ')}`);
    return errors;
  }

  if (e.capabilities !== undefined) {
    if (!isStringList(e.capabilities) || !e.capabilities.length) errors.push(`${at}: capabilities is a non-empty list`);
    else {
      for (const c of e.capabilities) {
        if (NOT_BUILT_CAPABILITIES[c]) errors.push(`${at}: ${NOT_BUILT_CAPABILITIES[c]}`);
        else if (!def.capabilities.includes(c)) errors.push(`${at}: the ${vendor} connector does not implement "${c}"`);
      }
    }
  }
  const caps = isStringList(e.capabilities) ? e.capabilities : [...def.capabilities];

  if (e.subscribes !== undefined) {
    if (!isStringList(e.subscribes) || !e.subscribes.length) errors.push(`${at}: subscribes is a non-empty list of ${vendor} event types`);
    else {
      for (const t of e.subscribes) {
        if (!sendsEvent(def, t)) errors.push(`${at}: subscribes names "${t}", which is not a ${vendor} event (${eventsShape(def)})`);
      }
      if (new Set(e.subscribes).size !== e.subscribes.length) errors.push(`${at}: subscribes names an event twice`);
      if (!caps.includes('ingest')) errors.push(`${at}: subscribes needs the ingest capability`);
    }
    if (typeof e.eventSource !== 'string' || !e.eventSource) {
      errors.push(`${at}: subscribes needs eventSource, the ${vendor} partner event source its events arrive through (${def.eventSource.shape})`);
    } else if (!e.eventSource.startsWith(def.eventSource.prefix)) {
      errors.push(`${at}: eventSource "${e.eventSource}" is not a ${vendor} partner event source; it starts with ${def.eventSource.prefix}`);
    } else if (!def.eventSource.pattern.test(e.eventSource) || e.eventSource.length > 256) {
      errors.push(`${at}: eventSource "${e.eventSource}" is malformed; a ${vendor} partner event source is ${def.eventSource.shape}`);
    } else if (seenSources.has(e.eventSource)) {
      errors.push(`${at}: eventSource "${e.eventSource}" is declared by another connector, and one source feeds one connector`);
    } else {
      seenSources.add(e.eventSource);
    }
    if (typeof e.classification !== 'string' || !e.classification) {
      errors.push(`${at}: subscribes needs a classification, the one the conversations its events concern are at (K4)`);
    } else if (!ctx.isConversational(e.classification)) {
      errors.push(`${at}: classification "${e.classification}" is not a conversational classification this deployment declares`);
    }
  } else {
    if (e.classification !== undefined) errors.push(`${at}: classification is read only for a connector that subscribes to events`);
    if (e.eventSource !== undefined) errors.push(`${at}: eventSource is read only for a connector that subscribes to events`);
  }

  if (e.personIssuer !== undefined) {
    const issuer = ctx.issuers.find((i) => i.id === e.personIssuer);
    if (!issuer) errors.push(`${at}: personIssuer "${String(e.personIssuer)}" is not an issuer the registry declares`);
    else if (typeof e.classification === 'string' && e.classification) {
      // K4 AT SYNTH: an issuer whose classifications cannot reach the classification admits nobody this connector names.
      const reaches = issuer.classifications.some((c) => ctx.grantsFor(c).includes(e.classification as string)
        && ctx.grantsFor(c).every((g) => issuer.classifications.includes(g)));
      if (!reaches) errors.push(`${at}: personIssuer "${issuer.id}" declares classifications that never reach "${e.classification}", so it would admit nobody`);
    }
  }

  if (e.grants !== undefined) {
    const g = e.grants as Partial<NonNullable<ConnectorConfig['grants']>>;
    if (!def.grants) errors.push(`${at}: the ${vendor} connector takes no per-person grant`);
    if (!g || typeof g !== 'object' || !isStringList(g.redirectUris) || !g.redirectUris.length) {
      errors.push(`${at}: grants names its redirectUris, the client addresses a vendor authorization returns to`);
    } else {
      for (const uri of g.redirectUris) {
        const why = redirectUriError(uri);
        if (why) errors.push(`${at}: grants redirect URI "${uri}" ${why}`);
      }
    }
    if (g?.scopes !== undefined && !isStringList(g.scopes)) errors.push(`${at}: grants scopes is a list of scope names`);
    if (!caps.includes('actForPerson')) errors.push(`${at}: grants needs the actForPerson capability`);
  } else if (isStringList(e.capabilities) && e.capabilities.includes('actForPerson')) {
    errors.push(`${at}: actForPerson needs grants, the redirect URIs a person completes the vendor's authorization on`);
  }

  if (e.loginUrl !== undefined) {
    if (vendor !== 'salesforce') errors.push(`${at}: loginUrl is read only for a salesforce connector`);
    else if (typeof e.loginUrl !== 'string' || !/^https:\/\/[a-z0-9.-]+$/i.test(e.loginUrl)) errors.push(`${at}: loginUrl is an https origin with no path`);
  }

  const known = new Set(['id', 'vendor', 'capabilities', 'subscribes', 'eventSource', 'classification', 'personIssuer', 'grants', 'loginUrl']);
  for (const k of Object.keys(e)) if (!known.has(k)) errors.push(`${at}: "${k}" is not a connector field`);
  return errors;
}

/**
 * Every reason the declared connectors and the capability list cannot be synthesized together. A
 * connector entry without the `connectors` capability is refused, and so is the capability with none.
 */
export function connectorErrors(raw: unknown[] | undefined, ctx: ConnectorContext, capabilities: readonly string[]): string[] {
  const declared = capabilities.includes('connectors');
  const list = raw ?? [];
  if (!declared) return list.length ? ['connectors are declared, and the connectors capability is not: add "connectors" to capabilities'] : [];
  if (!list.length) return ['the connectors capability is declared with no connector: declare at least one entry in connectors'];
  const seen = new Set<string>();
  const seenSources = new Set<string>();
  return list.flatMap((e, i) => entryErrors(e, i, ctx, seen, seenSources));
}

export interface ConnectorRegistry {
  readonly entries: readonly ConnectorConfig[];
  byId(id: string): ConnectorConfig | undefined;
  /** The connectors that receive vendor events, each a rule on its partner event bus. Empty: no receiver. */
  subscribing(): ConnectorConfig[];
  /** The connectors that hold per-person grants. Empty: no grants table. */
  withGrants(): ConnectorConfig[];
  /** The runtime form, for `CONNECTORS`. */
  runtime(): RuntimeConnector[];
}

/** Parse and validate the declared connectors, or throw naming every reason they cannot be synthesized. */
export function connectorRegistry(raw: unknown, ctx: ConnectorContext, capabilities: readonly string[]): ConnectorRegistry {
  const list = parseConnectorsContext(raw);
  const errors = connectorErrors(list, ctx, capabilities);
  if (errors.length) throw new Error(`connectors cannot be synthesized:\n  ${errors.join('\n  ')}`);
  const entries = (list ?? []) as ConnectorConfig[];
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    entries,
    byId: (id) => byId.get(id),
    subscribing: () => entries.filter((e) => e.subscribes?.length),
    withGrants: () => entries.filter((e) => e.grants),
    runtime: () => entries.map(runtimeConnector),
  };
}

/**
 * THE EVENT PATTERN of a subscribing connector's rule: its declared source, and exactly the event types it
 * subscribes to, where its vendor puts the type. The stack builds the rule from this, and the live
 * deny-test compares the deployed rule against it, so the two cannot describe different patterns.
 */
export function connectorEventPattern(c: Pick<ConnectorConfig, 'vendor' | 'subscribes' | 'eventSource'>): {
  source: string[];
  'detail-type': string[];
  detail?: { event: string[] };
} {
  const def = (VENDORS as Record<string, VendorDefinition>)[String(c.vendor)];
  if (!def || !c.eventSource || !c.subscribes?.length) throw new Error('an event pattern needs a built vendor, an eventSource and subscribes');
  const types = [...c.subscribes].sort();
  return def.eventSource.typeAt === 'detail-type'
    ? { source: [c.eventSource], 'detail-type': types }
    : { source: [c.eventSource], 'detail-type': [def.eventSource.detailType as string], detail: { event: types } };
}

function runtimeConnector(e: ConnectorConfig): RuntimeConnector {
  const def = VENDORS[e.vendor as 'pagerduty' | 'salesforce'];
  const base = (e.loginUrl || def.grants?.defaultLoginUrl || '').replace(/\/$/, '');
  return {
    id: e.id,
    vendor: def.vendor as RuntimeConnector['vendor'],
    capabilities: [...(e.capabilities ?? def.capabilities)],
    subscribes: [...(e.subscribes ?? [])],
    ...(e.eventSource ? { eventSource: e.eventSource } : {}),
    ...(e.classification ? { classification: e.classification } : {}),
    namespace: e.personIssuer || e.id,
    ...(e.grants && def.grants ? {
      grants: {
        redirectUris: [...e.grants.redirectUris],
        scopes: [...(e.grants.scopes ?? [])],
        tokenUrl: def.grants.tokenUrl.replace('{base}', base),
        revokeUrl: def.grants.revokeUrl.replace('{base}', base),
        revokeAuth: def.grants.revokeAuth,
      },
    } : {}),
  };
}

/** The runtime form of the registry, from a function's `CONNECTORS`. An unreadable value is no connector (fail closed). */
export function runtimeConnectors(raw: string | undefined): RuntimeConnector[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list as RuntimeConnector[]).filter((c) => c && typeof c.id === 'string' && c.vendor in VENDORS) : [];
  } catch {
    return [];
  }
}

/** The Secrets Manager name a connector's OAuth client secret carries, under the instance's resource prefix. */
export function connectorSecretNames(resourcePrefix: string, connectorId: string): { oauthClient: string } {
  return { oauthClient: `${resourcePrefix}/connector/${connectorId}/oauth-client` };
}
