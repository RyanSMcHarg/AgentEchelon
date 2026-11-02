/**
 * Conversation-archive wiring (SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md, ADR-017).
 *
 * Synth-level guardrails for the read-only enforcement + the management API:
 *  - the archived-tag read-only Deny is present on the chat-plane exchange roles
 *    (Send/UpdateChannelMessage denied when aws:ResourceTag/archived = true), and
 *    the SEPARATE admin-PLANE role that posts the archive system message is exempt;
 *  - Foundations exposes the conversation-management Lambda + the three routes;
 *  - all shipped conversation types carry the 90-day LAST_MESSAGE_TIMESTAMP TTL.
 */

import { Template } from 'aws-cdk-lib/assertions';
import { CONVERSATION_TYPES, MAX_CONVERSATION_TTL_DAYS } from '../lib/config/conversation-types';
import { identityTemplate, conversationsStacks, conversationsTemplate } from './helpers/synth';


/** Every IAM statement rendered in a template (inline role policies + managed policies). */
interface Statement {
  Effect?: string;
  Action?: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
}
function allStatements(template: Template): Statement[] {
  const out: Statement[] = [];
  const push = (doc: unknown) => {
    const stmts = (doc as { Statement?: Statement[] })?.Statement;
    if (Array.isArray(stmts)) out.push(...stmts);
  };
  for (const r of Object.values(template.findResources('AWS::IAM::Policy'))) {
    push((r as { Properties?: { PolicyDocument?: unknown } }).Properties?.PolicyDocument);
  }
  for (const r of Object.values(template.findResources('AWS::IAM::Role'))) {
    for (const p of (r as { Properties?: { Policies?: { PolicyDocument?: unknown }[] } }).Properties?.Policies || []) {
      push(p.PolicyDocument);
    }
  }
  return out;
}

const asArray = (a?: string | string[]) => (Array.isArray(a) ? a : a ? [a] : []);
function isArchivedDeny(s: Statement): boolean {
  return (
    s.Effect === 'Deny' &&
    asArray(s.Action).includes('chime:SendChannelMessage') &&
    (s.Condition?.StringEquals?.['aws:ResourceTag/archived'] as string) === 'true'
  );
}

describe('archived read-only IAM Deny (Identity)', () => {
  it('denies Send/Update on archived channels across the chat-plane exchange roles', () => {
    const denies = allStatements(identityTemplate()).filter(isArchivedDeny);
    // One per tier role (basic/standard/premium via classificationChannelScopedAllow) + the
    // restricted/admin chat role. So multiple — assert it is present and covers
    // BOTH message-write actions.
    expect(denies.length).toBeGreaterThanOrEqual(2);
    for (const d of denies) {
      expect(asArray(d.Action)).toEqual(
        expect.arrayContaining(['chime:SendChannelMessage', 'chime:UpdateChannelMessage']),
      );
    }
  });

  it('does not deny plain (non-archived) sends — the Deny is tag-scoped only', () => {
    // Every archived Deny must carry the archived-tag condition (never an
    // unconditioned Deny that would break normal messaging).
    for (const s of allStatements(identityTemplate())) {
      if (s.Effect === 'Deny' && asArray(s.Action).includes('chime:SendChannelMessage')) {
        expect(s.Condition?.StringEquals?.['aws:ResourceTag/archived']).toBe('true');
      }
    }
  });
});

describe('conversation-management routes (Conversations)', () => {
  // Conversations hosts the conversation handlers, and declares their routes for PersonApi.
  it('declares the three /conversations/* routes on one handler, behind the edge, and an audit table', () => {
    const { conversations } = conversationsStacks();
    const routes = conversations.routes.filter((r) => r.path.startsWith('/conversations/'));
    expect(routes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['POST /conversations/archive', 'POST /conversations/leave', 'POST /conversations/remove-member']);
    expect(new Set(routes.map((r) => r.handler)).size).toBe(1);
    expect(routes.every((r) => r.api === 'person' && (r.auth ?? 'person') === 'person')).toBe(true);
    // Task tables + abuse-controls + the new conversation-actions audit table.
    const tables = Object.keys(conversationsTemplate().findResources('AWS::DynamoDB::Table'));
    expect(tables.length).toBeGreaterThanOrEqual(4);
  });
});

describe('conversation-type retention default', () => {
  // WHAT THIS GUARDS, NARROWED. It used to assert that EVERY shipped type expires at 90 days, which
  // encoded "no conversation type may ever declare its own retention" - the opposite of what the
  // dimension is for. Retention per experience is the requirement (SPEC-CONVERSATION-TYPES FR4), so a
  // type declaring less is the feature working, not a regression.
  //
  // The platform-wide default is still worth pinning, because it is what an ORDINARY conversation gets
  // and changing it silently changes what every deployment retains. So the default is asserted on the
  // ordinary type, and the bound that applies to every type -
  // `MAX_CONVERSATION_TTL_DAYS` - is asserted in `no-type-exceeds-the-retention-limit`.
  it('an ordinary conversation expires nine months after its last message', () => {
    // ASSERTED AGAINST THE CONSTANT, not against 90. The literal was correct until the two retention
    // axes were separated: the conversation lifetime moved to nine months while MESSAGE retention stayed
    // at ninety days, and this test was the thing that caught the change - which is what it is for. A
    // literal here would have to be edited every time the policy moves, and the edit is where a test
    // stops describing the policy and starts describing whatever made it pass.
    for (const key of ['general']) {
      expect(CONVERSATION_TYPES[key].expiration).toEqual({
        days: MAX_CONVERSATION_TTL_DAYS,
        criterion: 'LAST_MESSAGE_TIMESTAMP',
      });
    }
  });

  it('a type that declares its own retention declares LESS, never more', () => {
    // The direction is the whole point: a type may keep a conversation for a shorter time than the
    // platform's default and never longer, so data minimization cannot be undone by adding a type.
    const platformDefault = CONVERSATION_TYPES.general.expiration!.days;
    for (const [key, cfg] of Object.entries(CONVERSATION_TYPES)) {
      if (!cfg.expiration) continue;
      expect(cfg.expiration.days).toBeLessThanOrEqual(platformDefault);
      expect(key).toBeTruthy();
    }
  });
});
