/**
 * Connectors — broad, per-vendor integrations a conversation type can attach to.
 *
 * **Design-only forward-compat seam.** Nothing here is consumed at runtime yet
 * (see docs/SPEC-CONVERSATION-TYPES.md §7). It exists so that
 * when a connector is actually built it slots into the conversation-type model
 * without a schema change or a handler `switch` — i.e. the door stays open.
 *
 * A **connector** is ONE integration to ONE external vendor (Salesforce,
 * ServiceNow, Twilio, AWS Support, Jira Service Desk, ServiceTitan, …).
 * Connectors are **broad per-vendor**, not capability-scoped micro-connectors:
 * a single Salesforce connector may do routing + case sync + identity + comms.
 * It declares WHICH capabilities it implements; the runtime consumes them
 * generically (never `switch (vendor)`).
 *
 * **Capabilities** (open set — add freely; old code ignores unknown ones):
 * - `resolveParticipant` — turn "bring in a human" into a concrete identity via
 *   the vendor's router/assignment (Salesforce Omnichannel, ServiceNow
 *   assignment, on-call rotation) or a dedicated/dispatched assignee. AE does
 *   NOT reimplement routing — it calls the vendor's API + existing AWS
 *   integrations (e.g. Salesforce→EventBridge). The resolved identity is then
 *   admitted as a Chime member at the channel's classification.
 * - `syncRecord` — create/update/read a ticket, case, or work order, and attach
 *   the (redaction-aware) transcript/summary.
 * - `fetchContext` — read external/observability data into the conversation
 *   (e.g. CloudWatch metrics / CloudTrail for an on-call triage dashboard).
 * - `provideComms` — supply a non-chat transport (Twilio voice+SMS phone
 *   numbers, Chime SDK Meetings). The conversation stays the hub: comms
 *   artifacts (e.g. a call transcript/summary) are posted back INTO the
 *   conversation channel + linked by reference. See `commsChannels` in
 *   conversation-types.ts.
 *
 * Identity note: Cognito is just today's identity adapter, NOT an "internal"
 * requirement. Participants authenticate via company SSO or a service login
 * (Salesforce, …); guests are already non-Cognito. Connectors + the IdP
 * abstraction (docs/IDENTITY-PROVIDER-GUIDE.md) resolve external participants
 * without migrating users.
 */

/** Open vendor key. The listed values are the spike's worked examples; the type
 *  is an open string so deployers add vendors without a type-system change. */
export type ConnectorVendor =
  | 'salesforce'
  | 'servicenow'
  | 'twilio'
  | 'aws-support'
  | 'jira-servicedesk'
  | 'servicetitan'
  | 'pagerduty'
  | (string & {});

/** Open capability key. `(string & {})` keeps autocomplete on the known set
 *  while allowing future capabilities — old consumers ignore unknown ones.
 *  `ingest` is the inbound mirror: a CRM webhook → platform actions. */
export type ConnectorCapability =
  | 'resolveParticipant'
  | 'syncRecord'
  | 'fetchContext'
  | 'provideComms'
  | 'ingest'
  | (string & {});

/**
 * Normalized, CRM-neutral platform event taxonomy — the OUTBOUND contract behind
 * the `syncRecord` capability. A connector `subscribes` to event types and maps
 * each to vendor operations (create case, log activity, update incident). Core
 * handlers emit these to a bus; connectors never see vendor SDKs in core code.
 * Open string for growth.
 */
export type PlatformEventType =
  | 'conversation.created'
  | 'message.received'
  | 'lead.qualified'
  | 'contact.captured'
  | 'meeting.scheduled'
  | 'meeting.completed'
  | 'conversation.summarized'
  | (string & {});

/** A normalized platform event a connector consumes (idempotent by `eventId`).
 *  `context.{contextType,contextId}` correlates the conversation to an external
 *  subject/record (user/job/meeting/case) — the anchor connectors use to upsert. */
export interface PlatformEvent<T = unknown> {
  eventId: string;
  type: PlatformEventType;
  occurredAt: string;
  context: { conversationArn?: string; contextType?: string; contextId?: string };
  payload: T;
}

export interface Connector {
  id: string;
  vendor: ConnectorVendor;
  /** Capabilities this vendor connector implements. Broad per-vendor: one
   *  connector may list several. */
  capabilities: ConnectorCapability[];
  /** For `syncRecord`: which {@link PlatformEventType}s this connector wants.
   *  The dispatcher routes matching events to this connector's handler.
   *  Absent ⇒ no outbound event subscriptions. */
  subscribes?: PlatformEventType[];
  /**
   * Scoped Secrets Manager secret holding the vendor credentials — never inline,
   * never a shared "all connectors" credential (security posture). The
   * isolation convention is a per-tenant path `connector/{tenantId}/{connectorId}`,
   * with the dispatcher's IAM scoped to the tenant it's handling that invocation —
   * a connector run for tenant A cannot read tenant B's secret (the load-bearing
   * boundary once the platform is multi-tenant; today AE is per-deployment).
   */
  credentialsSecretArn?: string;
  /** Vendor-specific config (project key, routing rule id, queue, account-team
   *  mapping, phone numbers, …). Opaque to the platform. Field mappings
   *  (platform event field → vendor field) live here as config, not code. */
  config?: Record<string, unknown>;
}

/** A conversation TYPE's reference to a connector + which of its capabilities
 *  that type relies on. (Type declares availability; a conversation INSTANCE
 *  holds the live {@link ExternalRef} bindings — type = policy, instance = state.) */
export interface ConnectorRef {
  connectorId: string;
  use?: ConnectorCapability[];
}

/** A conversation INSTANCE's binding to a concrete external record (the specific
 *  Salesforce case, ServiceNow incident, Twilio call). Lives in channel metadata
 *  at runtime, not in this static config — the conversation is the hub that
 *  holds these refs. Defined here so the shape is shared. */
export interface ExternalRef {
  connectorId: string;
  system: ConnectorVendor;
  recordId: string;
  url?: string;
}

/**
 * The connector registry. EMPTY by default — connectors are deploy-time config a
 * deployer adds. Lenient resolution: an unknown connectorId referenced by a type
 * is skipped + logged, never a hard failure (forward-compat contract).
 */
export const CONNECTORS: Record<string, Connector> = {};

/** Look up a connector by id (undefined if not registered — callers skip+log). */
export function getConnector(id: string): Connector | undefined {
  return CONNECTORS[id];
}

/** Does this connector implement the given capability? */
export function connectorImplements(id: string, capability: ConnectorCapability): boolean {
  return !!CONNECTORS[id]?.capabilities.includes(capability);
}
