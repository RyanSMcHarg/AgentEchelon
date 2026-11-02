/**
 * THE INVITATION-LINK ISSUER, AS THE IDENTITY STACK BUILDS IT (M-10, L16): what lets a `link` invitation's
 * holder in from its landing page with no sign-in, and the boundary they are held to once they are.
 *
 * Built only when the trusted-issuer registry declares an entry of kind `invitation-link`, so a deployment
 * without one carries no role and no redemption route for it, and issues no `link` invitation.
 *
 * ── WHAT IS HERE ─────────────────────────────────────────────────────────────────────────────────
 *
 *  - The kill switch: an SSM parameter under `SSM_ROOT` (`linkKillSwitchParameter`), created off, which a
 *    redeploy never resets. While it is on, every redemption is refused `paused`.
 *  - The address salt: a generated secret the per-address limit's hash is keyed with (`link-ip#` rows).
 *  - The `link` session role and its permissions boundary (below).
 *  - What the credential exchange needs to redeem: the switch, the salt, the captcha secret it names (never
 *    created here, never read at synth), the abuse-controls table's name, the `link` role, and the route.
 *  - The refusal alarm: a redemption refused `unavailable` means a control could not answer.
 *
 * ── THE `link` SESSION BOUNDARY (§5) ─────────────────────────────────────────────────────────────
 *
 * The role reaches ONE conversation, by construction rather than by the session policy alone. Its trust
 * requires three session tags: `person` (the invitee's AppInstanceUser), `channel` (the invited
 * conversation's id) and `classification`, which must be one the issuer declares (`fixed`). Its policy and
 * its permissions boundary name the channel as `channel/${aws:PrincipalTag/channel}` with its
 * `classification` tag required to equal the session's own, and the bearer as `user/${aws:PrincipalTag/person}`.
 * So, assumed with no session policy at all, the role reaches the one conversation its session was tagged
 * with, at a declared classification, as the invitee, with the read-and-post set, and nothing else: no
 * `CreateChannel`, no `CreateChannelMembership`, no other channel, no model, no S3. The exchange's session
 * policy narrows the same set again, and Amazon Chime SDK membership is the layer under both: a revoked
 * invitation's membership is gone, so its credential is refused on every channel call.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { invitationLinkSettingsOf, type IssuerConfig, type ResolvedInvitationLinkSettings } from '../config/issuers';
import { dataRemovalPolicy, environmentOf } from '../config/environment';
import { INSTANCE_NAME, SHARED_SSM, SSM_ROOT, alertEmitterWiring, archivedChannelReadOnlyDeny } from '../stacks/agent-classification-common';
import { GUEST_SESSION_ACTIONS } from './guest-issuer';
import type { RouteSpec, RouteThrottle } from './http-api';
import type { LinkConfig } from '../../lambda/src/lib/invitation-redemption';

/** The read-and-post set a `link` session holds on its one conversation: the guest's, and nothing more. */
export const LINK_SESSION_ACTIONS = GUEST_SESSION_ACTIONS;

/** The redemption route: a tight throttle for the whole route, every caller together (L16). */
export const LINK_REDEEM_THROTTLE: RouteThrottle = { rate: 5, burst: 10 };

/** The SSM parameter that pauses an invitation-link issuer's redemptions. */
export const linkKillSwitchParameter = (issuerId: string): string => `${SSM_ROOT}/invitation-link/${issuerId}/paused`;

export interface InvitationLinkIssuerProps {
  entry: IssuerConfig;
  appInstanceArn: string;
  exchangeRole: iam.Role;
  exchangeFunction: lambda.Function;
}

export class InvitationLinkIssuer extends Construct {
  readonly sessionRole: iam.Role;
  readonly sessionBoundary: iam.ManagedPolicy;
  readonly routes: RouteSpec[];
  readonly killSwitchParameter: string;
  readonly settings: ResolvedInvitationLinkSettings;
  /** The exchange's runtime view of this issuer. */
  readonly config: LinkConfig;

  constructor(scope: Construct, id: string, props: InvitationLinkIssuerProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const { entry, appInstanceArn, exchangeRole, exchangeFunction } = props;
    const settings = invitationLinkSettingsOf(entry);
    this.settings = settings;
    const reach = [...(entry.clearance as { fixed: string[] }).fixed];

    // ── THE KILL SWITCH AND THE SALT ─────────────────────────────────────────────────────────────
    const killSwitchName = linkKillSwitchParameter(entry.id);
    this.killSwitchParameter = killSwitchName;
    new ssm.StringParameter(this, 'KillSwitch', {
      parameterName: killSwitchName,
      description: `Pauses link invitation redemption for issuer "${entry.id}": {"paused": true|false, "changedBy", "changedAt", "reason"}.`,
      // CONSTANT, so a redeploy never resets a switch an operator has set.
      stringValue: JSON.stringify({ paused: false, changedBy: 'deploy', changedAt: 'initial' }),
    });
    const salt = new secretsmanager.Secret(this, 'AddressSalt', {
      description: `The salt link redemption hashes a source address with for issuer "${entry.id}"; never the address itself`,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: dataRemovalPolicy(this),
    });
    salt.grantRead(exchangeRole);

    // ── WHAT THE EXCHANGE READS AT RUNTIME ───────────────────────────────────────────────────────
    const parameterArn = (name: string) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${name}`;
    exchangeRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'LinkControlsRead',
      actions: ['ssm:GetParameter'],
      resources: [
        parameterArn(killSwitchName),
        // In Conversations, which deploys after this stack: read by name at runtime.
        parameterArn(SHARED_SSM.abuseControlsName),
        ...(settings.captcha.secretParameter ? [parameterArn(settings.captcha.secretParameter)] : []),
      ],
    }));
    if (settings.captcha.secretName) {
      exchangeRole.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'LinkCaptchaSecretRead',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${settings.captcha.secretName}-??????`],
      }));
    }

    // ── THE `link` SESSION ROLE, UNDER ITS BOUNDARY ──────────────────────────────────────────────
    const pinnedUser = `${appInstanceArn}/user/` + '${aws:PrincipalTag/person}';
    const pinnedChannel = `${appInstanceArn}/channel/` + '${aws:PrincipalTag/channel}';
    const sessionStatements = (): iam.PolicyStatement[] => [
      new iam.PolicyStatement({ sid: 'SessionEndpoint', actions: ['chime:GetMessagingSessionEndpoint'], resources: ['*'] }),
      new iam.PolicyStatement({ sid: 'ConnectAsTheInvitee', actions: ['chime:Connect'], resources: [pinnedUser] }),
      new iam.PolicyStatement({
        sid: 'TheInvitedConversation',
        actions: [...LINK_SESSION_ACTIONS],
        resources: [pinnedChannel],
        // THE CONVERSATION'S CLASSIFICATION IS THE SESSION'S, which the trust holds to the issuer's set.
        conditions: { StringEquals: { 'aws:ResourceTag/classification': '${aws:PrincipalTag/classification}' } },
      }),
      new iam.PolicyStatement({ sid: 'AsTheInvitee', actions: [...LINK_SESSION_ACTIONS], resources: [pinnedUser] }),
    ];
    this.sessionBoundary = new iam.ManagedPolicy(this, 'SessionBoundary', {
      description: `The boundary of a link invitation session (issuer "${entry.id}"): one conversation, read and post, as the invitee`,
      statements: sessionStatements(),
    });
    const tagPin = {
      StringLike: { 'aws:RequestTag/person': '*', 'aws:RequestTag/channel': '*' },
      StringEquals: { 'aws:RequestTag/classification': reach },
    };
    this.sessionRole = new iam.Role(this, 'SessionRole', {
      assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(exchangeRole.roleArn), tagPin),
      permissionsBoundary: this.sessionBoundary,
      maxSessionDuration: cdk.Duration.hours(1),
      description: `A link invitation's session (issuer "${entry.id}"): the invited conversation, read and post, as the invitee`,
    });
    this.sessionRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      principals: [new iam.ArnPrincipal(exchangeRole.roleArn)],
      actions: ['sts:TagSession'],
      conditions: tagPin,
    }));
    for (const st of sessionStatements()) this.sessionRole.addToPolicy(st);
    this.sessionRole.addToPolicy(archivedChannelReadOnlyDeny(appInstanceArn));
    exchangeRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'LinkSessionAssume',
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [this.sessionRole.roleArn],
    }));
    const alerts = alertEmitterWiring(this);
    alerts.grant(exchangeRole);
    for (const [k, v] of Object.entries(alerts.env)) exchangeFunction.addEnvironment(k, v);

    this.config = {
      issuerId: entry.id,
      reach,
      settings,
      roleArn: this.sessionRole.roleArn,
      killSwitchParameter: killSwitchName,
      addressSaltSecret: salt.secretArn,
      abuseTableParameter: SHARED_SSM.abuseControlsName,
      environment: environmentOf(this),
    };

    this.routes = [
      { api: 'person', method: 'POST', path: '/invitations/redeem', handler: exchangeFunction, capability: 'core', auth: 'none', throttle: LINK_REDEEM_THROTTLE },
    ];

    new cloudwatch.Alarm(this, 'UnavailableAlarm', {
      alarmName: `${stack.stackName}-invitation-link-unavailable`,
      alarmDescription: 'A link invitation redemption was refused because a control could not answer (the kill switch, the limit store, '
        + 'the captcha verifier or the token store). Every control fails closed.',
      metric: new cloudwatch.Metric({
        namespace: 'AgentEchelon/Invitations', metricName: 'InvitationRefused', statistic: 'Sum',
        period: cdk.Duration.minutes(5), dimensionsMap: { Instance: INSTANCE_NAME, Reason: 'unavailable' },
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
