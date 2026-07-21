# SPEC: Connectors - integrate with the business's systems, don't replace them

**Status:** Design (the schema seam ships; the runtime path is not built). The connector schema lives in config today (`conversation-types.ts` + `connectors.ts`); this spec is the contract those seams point at, promoted out of `../conversation-config/SPEC-CONVERSATION-TYPES.md` section 6.

**Problem and who it's for:** A conversation almost always has to touch the business's own systems of record - the CRM case, the ticket, the calendar, the phone line - and teams want to wire those in by configuration, reading each system live, rather than duplicating its data into a new silo or hand-coding and owning a bespoke integration per system. This is for the AI developer and admin/operator who connect an experience to external systems, and the platform developer building an integration. It defines a connector as one governed integration to one external vendor, declared as config, reading each source of truth live rather than duplicating it.

**Site section:** Interaction layer, Connectors pillar (core plane).

## What a connector is

A **connector** is one integration to one external vendor (a CRM, a ticketing system, a telephony provider, a support desk). It is **broad per-vendor**: one connector may implement several capabilities, and the runtime consumes them generically - it never branches on the vendor. Capabilities are an **open set**:

- **Resolve a participant** - turn "bring in the account's owner" into a concrete person the conversation admits (this feeds a conversation type's `resolveVia`).
- **Fetch a record** - read a case, ticket, or profile live from the source of truth.
- **Sync a record** - write an artifact back (open a case, post an update, dispatch a job).
- **Transport** - carry the conversation over a non-chat channel (voice, SMS, meeting); this is the Communication-layer connectivity a client reaches the conversation through.

The conversation is the **runtime hub** every connector attaches to: a connector posts its artifacts (summaries, structured cards) back into the conversation and links external records by reference (an `ExternalRef`), so nothing needs a separate aggregate store - the channel is the conversation, and everything attaches to it. A conversation-matcher routes inbound external comms to the right conversation.

## Declared as config, bound per conversation

A conversation **type** declares which connectors an experience *may* use (`connectors[]`, plus `resolveVia` for participant resolution); a conversation **instance** holds the live bindings (`ExternalRef` - the specific case or call). Adding an integration is a config entry plus the connector, never a `switch (type)` or `switch (vendor)` in handler code. That is what keeps "integrate with the business's systems" a configuration step rather than new code per system, and it is the same composition root as the rest of the interaction layer (`../conversation-config/SPEC-CONVERSATION-TYPES.md`).

## Read live, don't duplicate

A connector reads each source of truth **live** and links it by reference; it does not rebuild or duplicate the system it integrates. The record stays authoritative in the vendor's system; the conversation holds a reference plus the artifacts posted back into it. This is the "integrate, don't migrate" tenet made concrete at the data layer: no shadow copy of the CRM, no sync-and-drift.

## Security: per-tenant credential isolation

Connector credentials are held **per vendor, per tenant** in AWS Secrets Manager (`connector/{tenantId}/{connectorId}`) with scoped IAM, so one tenant's connector run cannot read another's secret. Outbound actions (dial, open case, dispatch) are **audited**. A human a connector resolves into a conversation is admitted under the conversation's **same classification** - connectors *feed* admission, they never bypass it. So an integration widens reach without widening the access boundary: the classification tag, the IAM keyed on it, and fail-closed resolution all still hold around a connector call.

## Governed MCP as the intended vehicle

The ecosystem is converging on MCP (Model Context Protocol) as the way agents reach tools. Because access here is already an IAM decision with bearer-pinned identity, MCP tools plug into the **same governed substrate** - scoped by classification, guardrailed, and audited like everything else - so a governed MCP server is the intended vehicle for the connector runtime. You get the reach and keep the control you already had, and a new tool is a configuration step on the governed platform, not a new system to secure.

## Resolution is lenient

Connector resolution is **lenient**: an unknown type, field, or connector resolves to a safe default or is skipped and logged, never a hard failure, and newer-schema and older-schema both resolve safely. A missing or misconfigured connector degrades the experience gracefully rather than breaking a conversation.

## Status and scope

The connector **schema** ships (the `conversation-types.ts` + `connectors.ts` seams, additive, defaulting to today's profile). The connector **runtime** - the capability implementations, the credential-isolation wiring, and the governed-MCP seam - is designed, not built. The smallest end-to-end path is a routed service-desk ticket for an internal-IT experience (in-context help, then a routed ticket) - one `ConversationTypeConfig` entry plus one connector, no new handler code.
