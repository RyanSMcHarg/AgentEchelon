/**
 * A PERSON'S VEND ROLE (SPEC-CREDENTIAL-EXCHANGE §5a), one per classification a person may be vended at,
 * built by the stack that owns that classification: `Assistants-<classification>` for a conversational one,
 * `Identity` for the admin plane and the one-conversation (`restricted`) role. So declaring a classification
 * adds its vend role with its own stack and changes no other stack (the classification-independence plan,
 * step 4).
 *
 * WHAT HOLDS IT TOGETHER WITHOUT A LIST:
 *
 *   - every vend role is on one IAM path, `/<instance>/exchange/`, and the credential exchange may assume a
 *     role on that path carrying this instance's `Instance` tag, never a list of ARNs;
 *   - the TRUST side keeps the pin: a role is assumable by the exchange's own role alone, and only with the
 *     `person` session tag (the bearer) and the `classification` tag equal to its own (the role choice and the
 *     clearance computation must agree), on the assume and on the tagging;
 *   - its boundary is its own statements, so a grant attached later reaches nothing more;
 *   - its ARN is published under the classification's own key (`exchangeRoleArnKey`), which the exchange reads
 *     at call time (`lambda/src/lib/exchange-role-arn.ts`), and its name is fixed (`exchangeRoleName`), so the
 *     admin backend's role-to-scope map names it without a reference to the stack that owns it.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { permissionsBoundary } from './permissions-boundary';
import {
  classificationChannelScopedAllow, archivedChannelReadOnlyDeny, INSTANCE_NAME, RES_PREFIX, SSM_ROOT, type Classification,
} from '../stacks/agent-classification-common';
import { INSTANCE_TAG } from '../tagging';
import { ADMIN_PLANE_SESSION_TAG, defaultProfileRegistry as profiles } from '../profile-registry';
import { issuerClassificationsOf, type IssuerRegistry } from '../config/issuers';

/** What a vend role is minted for: one conversation, a classification, or the admin plane's chat identity. */
export type VendToken = 'restricted' | Classification | 'admin';

/** The IAM path every vend role is on. The exchange may assume a role on it, and on no other path. */
export const EXCHANGE_ROLE_PATH = `/${INSTANCE_NAME}/exchange/`;

/** The SSM key a vend role's ARN is published under, by the stack that owns it, beside the classification's other keys. */
export function exchangeRoleArnKey(token: string): string {
  return `${SSM_ROOT}/assistant/${token}/exchange-role-arn`;
}

/** The SSM root the exchange reads a vend role's ARN under (`EXCHANGE_ROLE_ARN_PARAM_ROOT`). */
export const EXCHANGE_ROLE_ARN_PARAM_ROOT = `${SSM_ROOT}/assistant`;

/**
 * A vend role's fixed name. IAM allows 64 characters, and a name that does not fit is refused at synth rather
 * than truncated, since two truncated names could collide.
 */
export function exchangeRoleName(token: string): string {
  const name = `${RES_PREFIX}-exchange-${token}`;
  if (name.length > 64) throw new Error(`exchangeRoleName: "${name}" is longer than IAM's 64 characters; shorten the instance name or the classification value`);
  return name;
}

/** A vend role's ARN, from its fixed name and path, for a consumer that maps roles without referencing them. */
export function exchangeRoleArnOf(stack: cdk.Stack, token: string): string {
  return `arn:aws:iam::${stack.account}:role${EXCHANGE_ROLE_PATH}${exchangeRoleName(token)}`;
}

/**
 * THE CLASSIFICATIONS A PERSON IS VENDED A ROLE AT: every member classification, and an outside one a signed-in
 * issuer reaches (the customer, path B's target). The guest's never: its people are vended on the guest-session
 * role, pinned to their one conversation.
 */
export function vendedClassifications(issuers: IssuerRegistry): string[] {
  const outside = profiles.outsideClassificationValues();
  const signedInOutside = [...new Set(issuers.entries
    .filter((e) => e.kind !== 'guest')
    .flatMap((e) => issuerClassificationsOf(e, profiles))
    .filter((v) => outside.includes(v)))];
  return [...profiles.memberClassificationValues(), ...signedInOutside];
}

// The minimal channel actions the frontend uses. UpdateChannel is included for OWNER RENAME only: Amazon Chime
// SDK authorizes it on ChannelModerator status, so a non-moderator member is denied by the service regardless
// of what this policy allows. Redact/Delete (message or channel) stay moderator/backend-only.
//
// THE OWNER IS A MODERATOR BECAUSE THE CREATOR PROMOTES THEM: the service admin creates the conversation
// (`lib/channel-creation.ts`), adds the person as a `DEFAULT` member and promotes them with an explicit
// `CreateChannelModerator`. At the Chime layer the owner therefore holds full moderator authority over their
// conversation, and only this action list and the exchange's per-request narrowing keep the vended credential
// down to rename. Widen it deliberately or not at all.
const EXCHANGE_MSG_ACTIONS = [
  'chime:SendChannelMessage',
  'chime:GetChannelMessage',
  'chime:ListChannelMessages',
  'chime:DescribeChannel',
  'chime:ListChannelMemberships',
  // The channel's live moderator list, so the client knows whether it moderates from the authoritative source.
  'chime:ListChannelModerators',
  'chime:UpdateChannelReadMarker',
  'chime:UpdateChannel',
];

/**
 * THE BEARER-PINNED, MINIMAL PERMISSION SET OF A VEND ROLE (SPEC-CREDENTIAL-EXCHANGE §5a). Every vend role is
 * pinned to `${appInstanceArn}/user/${aws:PrincipalTag/person}`; the action set and the channel scope differ by
 * token.
 */
export function exchangeVendStatements(appInstanceArn: string, token: VendToken): iam.PolicyStatement[] {
  // Built by concatenation so the `${aws:PrincipalTag/person}` policy variable is emitted literally.
  const pinnedUser = `${appInstanceArn}/user/` + '${aws:PrincipalTag/person}';
  const out: iam.PolicyStatement[] = [
    // Session: the endpoint is identity-less; Connect bears the pinned user only.
    new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['chime:GetMessagingSessionEndpoint'], resources: ['*'] }),
    new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['chime:Connect'], resources: [pinnedUser] }),
  ];
  if (token === 'restricted') {
    // restricted: scoped by ADMISSION (a member of one channel; Amazon Chime SDK enforces membership), with no
    // classification tag condition.
    out.push(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: EXCHANGE_MSG_ACTIONS, resources: [`${appInstanceArn}/channel/*`] }),
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: EXCHANGE_MSG_ACTIONS, resources: [pinnedUser] }),
      // An archived channel is read-only for every chat-plane identity (ADR-017); the classification roles get
      // the same Deny through `classificationChannelScopedAllow`.
      archivedChannelReadOnlyDeny(appInstanceArn),
    );
  } else {
    // A classification: the channel gated on the tag, over every classification its own declares (a PERSON's
    // role, which a premium user speaking in a basic room needs where premium declares basic), and the bearer
    // pinned. THE ADMIN PLANE'S CHAT ROLE IS ONE OF THESE: it grants itself alone, so a person holding only the
    // admin plane reaches admin conversations and no other. A chat identity never reaches every conversation;
    // that reach is admin access, on the separate `${personId}-admin` identity (SPEC-ADMIN-IDENTITY FR1).
    out.push(...classificationChannelScopedAllow(token as Classification, appInstanceArn, EXCHANGE_MSG_ACTIONS, {
      actor: 'person',
      bearerResources: [pinnedUser],
    }));
    // ADMIN CONVERSATIONS, FOR A MEMBER WHO ALSO HOLDS THE ADMIN PLANE: a channel tagged with the admin plane's
    // classification, only when the exchange asserted the `adminPlane` session tag. Conditioned on tags, never
    // on a listed set of member classifications, so declaring a classification changes no other role.
    const plane = profiles.adminPlaneValues();
    if (plane.length && !plane.includes(token) && profiles.audienceOf(token) === 'members') {
      out.push(new iam.PolicyStatement({
        sid: 'AllowAdminPlaneChannelActionsWhenHeld',
        effect: iam.Effect.ALLOW,
        actions: EXCHANGE_MSG_ACTIONS,
        resources: [`${appInstanceArn}/channel/*`],
        conditions: {
          StringEquals: {
            'aws:ResourceTag/classification': plane,
            [`aws:PrincipalTag/${ADMIN_PLANE_SESSION_TAG}`]: 'true',
          },
        },
      }));
    }
  }
  // The one-conversation role stops here: no discovery, no self-membership management, no profile writes.
  if (token !== 'restricted') {
    out.push(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['chime:DescribeAppInstanceUser', 'chime:UpdateAppInstanceUser'], resources: [pinnedUser] }),
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['chime:ListChannelMembershipsForAppInstanceUser', 'chime:DescribeChannelMembership'], resources: [pinnedUser] }),
      // Leave a channel: remove OWN membership only, on a channel they are in (Amazon Chime SDK membership-gates).
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['chime:DeleteChannelMembership'], resources: [pinnedUser, `${appInstanceArn}/channel/*`] }),
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['chime:ListChannels'], resources: [appInstanceArn] }),
    );
  }
  return out;
}

/**
 * The session the exchange must assert to assume a vend role: who (`person`) and at what (`classification`),
 * and, only as `true` when it is asserted at all, whether the admin plane is held beside it (`adminPlane`). No
 * other session tag key is accepted.
 */
export function vendTagPin(token: string): Record<string, Record<string, string | string[]>> {
  return {
    StringLike: { 'aws:RequestTag/person': '*' },
    StringEquals: { 'aws:RequestTag/classification': token },
    StringEqualsIfExists: { [`aws:RequestTag/${ADMIN_PLANE_SESSION_TAG}`]: 'true' },
    'ForAllValues:StringEquals': { 'aws:TagKeys': ['person', 'classification', ADMIN_PLANE_SESSION_TAG] },
  };
}

/**
 * ONE VEND ROLE, ITS BOUNDARY AND ITS PUBLISHED ARN.
 *
 * The conditions go on the ASSUME, not only on the tagging: a bare `ArnPrincipal` emits an unconditioned
 * `sts:AssumeRole`, so `PrincipalWithConditions` puts the `person` and `classification` pins on the assume
 * itself and an untagged assume is refused. The `sts:TagSession` statement carries the same pins. A mismatch
 * fails at `AssumeRole` with an explicit error rather than minting a session whose every call is denied.
 *
 * The value is the exchange's `resolveRoleKey` vocabulary, the classification value itself, so the role choice
 * and the clearance computation (`clearanceForGroups`) have to agree for AWS to mint the session.
 */
export class ExchangeRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: {
    appInstanceArn: string;
    token: VendToken;
    /** The credential exchange's own execution role, the only principal that may assume this one. */
    exchangeRoleArn: string;
  }) {
    super(scope, id);
    const { token } = props;
    const statements = exchangeVendStatements(props.appInstanceArn, token);
    // THE BOUNDARY IS TODAY'S REACH: the role's own statements, so a grant attached to it later, by this stack
    // or another, reaches nothing it does not already, and a session vended on it is bounded the same.
    const boundary = permissionsBoundary(this, 'Boundary',
      `The boundary of the ${token} vend role: its bearer-pinned messaging set, and nothing else`, exchangeVendStatements(props.appInstanceArn, token));
    this.role = new iam.Role(this, 'Role', {
      roleName: exchangeRoleName(token),
      path: EXCHANGE_ROLE_PATH,
      assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(props.exchangeRoleArn), vendTagPin(token)),
      permissionsBoundary: boundary,
    });
    for (const st of statements) this.role.addToPolicy(st);
    this.role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ArnPrincipal(props.exchangeRoleArn)],
      actions: ['sts:TagSession'],
      conditions: vendTagPin(token),
    }));
    new ssm.StringParameter(this, 'Arn', {
      parameterName: exchangeRoleArnKey(token),
      stringValue: this.role.roleArn,
      description: `The ${token} vend role, which the credential exchange assumes for a person cleared for it`,
    });
  }
}

/**
 * THE EXCHANGE MAY ASSUME A VEND ROLE OF THIS INSTANCE, and read where one is published: any role on
 * `EXCHANGE_ROLE_PATH` carrying this instance's `Instance` tag (a path that starts with the instance name also
 * matches a longer instance name's path only up to the separator, and the tag closes the rest), with the
 * session tagging the trust side requires. No ARN is listed, so declaring a classification changes nothing
 * here.
 */
export function assumeAnyVendRoleStatements(stack: cdk.Stack): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'AssumeAVendRoleOfThisInstance',
      effect: iam.Effect.ALLOW,
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [`arn:aws:iam::${stack.account}:role${EXCHANGE_ROLE_PATH}*`],
      conditions: { StringEquals: { [`aws:ResourceTag/${INSTANCE_TAG}`]: INSTANCE_NAME } },
    }),
    new iam.PolicyStatement({
      sid: 'FindAVendRoleByItsClassification',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [cdk.Arn.format({ service: 'ssm', resource: 'parameter', resourceName: exchangeRoleArnKey('*').replace(/^\//, '') }, stack)],
    }),
  ];
}
