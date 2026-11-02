/**
 * EVERY TAG GRANT BUT ONE EXCLUDES `owner-team` (SPEC-ADMIN-CONSOLE FR47, DESIGN-ADMIN-CONSOLE 5.2).
 *
 * The `owner-team` tag on an assistant's `AppInstanceBot` decides which assistants a team member's
 * console reaches, so it is an ownership record only while nobody it scopes can write it. The
 * deployment grants `chime:TagResource` in many places - provisioners stamping classification, the
 * conversation creators tagging channels, the exchange tagging identities, permission boundaries
 * allowing `chime:*` - and each of those, written by hand, is a place to forget a condition.
 *
 * So the condition is applied once, here, to every IAM policy in the app: any Allow statement that
 * can tag or untag gains `ForAllValues:StringNotEquals aws:TagKeys owner-team`. A request that names
 * no tag keys is unaffected (the operator holds for an empty set), so the many non-tagging actions in
 * a broad statement keep working. The ownership function's own statement, `OwnerTeamTagOnly`, is the
 * single exception.
 *
 * APPLIED AS AN OVERRIDE, NOT BY REWRITING THE DOCUMENT. The document is resolved only to find which
 * statements can tag; the condition is then added at each one's path. Rewriting the document itself
 * would resolve the references in it early, and a reference to another stack's resource resolved that
 * way is no longer one CDK can see and turn into an import.
 *
 * `every-tag-grant-excludes-ownership.test.ts` reads the synthesized templates and refuses any grant
 * this missed; the deny-test proves the same against the deployed policies.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';
import { OWNER_TEAM_TAG } from '../stacks/agent-classification-common';

/** The `Sid` of the one statement allowed to write `owner-team`. */
export const OWNER_TEAM_WRITER_SID = 'OwnerTeamTagOnly';
/**
 * The `Sid` prefix of the provisioner's create-time stamp, one statement per classification
 * (`runtimeAssistantProvisioningAllow`, ADR-048), held by the provisioner's session role alone.
 * It writes `assistant` and `role` only on a bot that already carries `provisioner=runtime` and that
 * classification, so it cannot relabel another assistant. Measured 2026-10-13: without this, the exclusion
 * below refused every runtime create.
 */
export const RUNTIME_IDENTITY_WRITER_SID_PREFIX = 'TagRuntimeAssistantIdentityAtCreate';

/**
 * THE KEYS ONLY ONE WRITER MAY SET, and that writer. `owner-team` decides which assistants a team reaches;
 * `assistant` and `role` say which assistant a bot is, which is what that ownership, the team routes and
 * the acting role all key on, so rewriting either would move a bot into another assistant's scope. Each
 * is excluded from every other tag grant. `classification` is not here: channels and identities take it
 * from many writers, and a bot's is pinned instead by the provisioner's `aws:ResourceTag` condition.
 */
export const PROTECTED_TAG_WRITERS: Readonly<Record<string, readonly string[]>> = {
  [OWNER_TEAM_TAG]: [OWNER_TEAM_WRITER_SID],
  assistant: [`${RUNTIME_IDENTITY_WRITER_SID_PREFIX}*`],
  role: [`${RUNTIME_IDENTITY_WRITER_SID_PREFIX}*`],
};

/** Whether a statement's `Sid` is one of a key's writers; an entry ending in `*` names a prefix. */
const isWriter = (sid: string, writers: readonly string[]): boolean =>
  writers.some((w) => (w.endsWith('*') ? sid.startsWith(w.slice(0, -1)) : sid === w));

/** The protected keys a statement may not write: every one whose writer it is not. */
export function keysExcludedFor(sid: string | undefined): string[] {
  return Object.entries(PROTECTED_TAG_WRITERS).filter(([, writers]) => !sid || !isWriter(sid, writers)).map(([key]) => key);
}

/** The actions that write a tag on an Amazon Chime SDK resource. */
const TAG_WRITING_ACTIONS = ['chime:TagResource', 'chime:UntagResource'];

type Statement = { Sid?: string; Effect?: string; Action?: unknown; NotAction?: unknown; Condition?: Record<string, Record<string, unknown>> };

/** Whether an IAM action pattern (`*` and `?` wildcards, case-insensitive) matches an action. */
function actionMatches(pattern: string, action: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(action);
}

/**
 * Whether an Allow statement can write a tag: an `Action` that matches either tag action by wildcard
 * (`chime:Tag*`, `chime:*Resource`, `chime:*`, `*`), or a `NotAction` that does not exclude both.
 */
export function canWriteTags(s: Statement): boolean {
  if (s.Effect !== 'Allow') return false;
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((a): a is string => typeof a === 'string');
  if (s.NotAction !== undefined) {
    const excluded = list(s.NotAction);
    return TAG_WRITING_ACTIONS.some((t) => !excluded.some((p) => actionMatches(p, t)));
  }
  return list(s.Action).some((p) => TAG_WRITING_ACTIONS.some((t) => actionMatches(p, t)));
}

/** Add the exclusion to every tag-writing statement of a resolved document, by override under `prefix`. */
function excludeIn(node: cdk.CfnResource, doc: unknown, prefix: string): void {
  const statements = (doc as { Statement?: Statement[] } | undefined)?.Statement;
  if (!Array.isArray(statements)) return;
  statements.forEach((s, i) => {
    if (!canWriteTags(s)) return;
    const excluded = keysExcludedFor(s.Sid);
    if (excluded.length === 0) return;
    const existing = s.Condition?.['ForAllValues:StringNotEquals']?.['aws:TagKeys'];
    const keys = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    node.addPropertyOverride(
      `${prefix}.Statement.${i}.Condition.ForAllValues:StringNotEquals.aws:TagKeys`,
      [...new Set([...keys, ...excluded])],
    );
  });
}

/** Applied at the app root, after every grant has been added. */
export class ExcludeOwnerTeamTag implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (node instanceof iam.CfnPolicy || node instanceof iam.CfnManagedPolicy) {
      excludeIn(node, cdk.Stack.of(node).resolve(node.policyDocument), 'PolicyDocument');
    } else if (node instanceof iam.CfnRole) {
      const policies = cdk.Stack.of(node).resolve(node.policies) as Array<Record<string, unknown>> | undefined;
      // Resolved here the entries are still the L1 property shape (`policyDocument`); the override
      // path is CloudFormation's (`PolicyDocument`), which is what the rendered template carries.
      policies?.forEach((p, j) => excludeIn(node, p.policyDocument ?? p.PolicyDocument, `Policies.${j}.PolicyDocument`));
    } else if (node instanceof cdk.CfnResource && node.cfnResourceType === 'AWS::IAM::Role') {
      // A role rendered as a raw resource rather than a `CfnRole`: a `CustomResourceProvider`'s, as
      // `cdk-amazon-chime-resources` builds for the app instance (it holds `chime:TagResource`). Its
      // properties are only reachable as the construct's own property bag.
      const props = (node as unknown as { _cfnProperties?: Record<string, unknown> })._cfnProperties;
      const policies = cdk.Stack.of(node).resolve(props?.Policies) as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(policies)) policies.forEach((p, j) => excludeIn(node, p.PolicyDocument, `Policies.${j}.PolicyDocument`));
    }
  }
}
