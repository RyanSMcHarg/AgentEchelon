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

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ChimeMessagingStack } from '../lib/stacks/chime-messaging-stack';
import { CognitoAuthStack } from '../lib/stacks/cognito-auth-stack';
import { FoundationsStack } from '../lib/stacks/foundations-stack';
import { CONVERSATION_TYPES } from '../lib/config/conversation-types';

const env = { account: '123456789012', region: 'us-east-1' };

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

describe('archived read-only IAM Deny (CognitoAuth)', () => {
  function cognitoTemplate() {
    const app = new cdk.App();
    const chime = new ChimeMessagingStack(app, 'Chime', { env, appInstanceName: 'test' });
    const cog = new CognitoAuthStack(app, 'Cog', { env, appInstanceArn: chime.appInstanceArn });
    return Template.fromStack(cog);
  }

  it('denies Send/Update on archived channels across the chat-plane exchange roles', () => {
    const denies = allStatements(cognitoTemplate()).filter(isArchivedDeny);
    // One per tier rung (basic/standard/premium via tierChannelScopedAllow) + the
    // restricted/admin chat rung. So multiple — assert it is present and covers
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
    for (const s of allStatements(cognitoTemplate())) {
      if (s.Effect === 'Deny' && asArray(s.Action).includes('chime:SendChannelMessage')) {
        expect(s.Condition?.StringEquals?.['aws:ResourceTag/archived']).toBe('true');
      }
    }
  });
});

describe('conversation-management API (Foundations)', () => {
  function foundationsTemplate() {
    const app = new cdk.App();
    const chime = new ChimeMessagingStack(app, 'Chime', { env, appInstanceName: 'test' });
    const found = new FoundationsStack(app, 'Found', {
      env,
      appInstanceArn: chime.appInstanceArn,
      userPoolId: 'us-east-1_TestPool',
    });
    return Template.fromStack(found);
  }

  it('provisions the three /conversations/* resources + an audit table', () => {
    const t = foundationsTemplate();
    const paths = Object.values(t.findResources('AWS::ApiGateway::Resource')).map(
      (r) => (r as { Properties?: { PathPart?: string } }).Properties?.PathPart,
    );
    expect(paths).toEqual(expect.arrayContaining(['conversations', 'archive', 'remove-member', 'leave']));
    // Task tables + abuse-controls + the new conversation-actions audit table.
    const tables = Object.keys(t.findResources('AWS::DynamoDB::Table'));
    expect(tables.length).toBeGreaterThanOrEqual(4);
  });

  it('returns CORS headers on gateway error responses (4XX/5XX)', () => {
    const t = foundationsTemplate();
    const responses = Object.values(t.findResources('AWS::ApiGateway::GatewayResponse')).map(
      (r) => (r as { Properties?: { ResponseType?: string } }).Properties?.ResponseType,
    );
    expect(responses).toEqual(expect.arrayContaining(['DEFAULT_4XX', 'DEFAULT_5XX']));
  });
});

describe('conversation-type retention default', () => {
  it('every shipped type expires 90 days after last message', () => {
    for (const [key, cfg] of Object.entries(CONVERSATION_TYPES)) {
      expect(cfg.expiration).toEqual({ days: 90, criterion: 'LAST_MESSAGE_TIMESTAMP' });
      expect(key).toBeTruthy();
    }
  });
});
