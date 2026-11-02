/**
 * THE GUEST ISSUER, AS THE IDENTITY STACK BUILDS IT (A7, L16): what lets an anonymous visitor in, and
 * the boundary they are held to once they are.
 *
 * Built only when the trusted-issuer registry declares an entry of kind `guest`, so a deployment without
 * one carries no key, no role and no route for it.
 *
 * ── WHAT IS HERE ─────────────────────────────────────────────────────────────────────────────────
 *
 *  - The signing keys: one KMS key per key generation (`guest.signingKeys`, default `['g1']`), each
 *    `ECC_NIST_P256` and `SIGN_VERIFY`, with an alias naming the instance and the generation. The last
 *    generation signs; the edge verifies against every listed one. KMS does not rotate an asymmetric key
 *    itself, so rotation is the procedure in docs/guides/admin/GUEST-ISSUER.md: add a generation, wait one
 *    token lifetime plus the edge cache, remove the old one (its key is scheduled for deletion).
 *  - The throttle alarm: guest start counts a KMS `ThrottlingException` on `Sign` (the request quota is
 *    shared with every other key in the account and region), and an alarm fires on the first one.
 *  - The refusal alarm: a refusal for `unavailable` means a control could not answer, which an operator
 *    must hear about, so it alarms as well as raising an `ae.alert`.
 *  - The kill switch: an SSM parameter under `SSM_ROOT` (`guestKillSwitchParameter`), created off. A
 *    deploy writes it only when its template value changes, which this one never does, so an operator's
 *    switch survives a redeploy. `scripts/guest-switch.mjs` changes it, recording who.
 *  - The address salt: a generated secret the per-address limit's hash is keyed with, so the stored key
 *    is not reversible to the address.
 *  - The guest-session role and its permissions boundary (below).
 *  - What the credential exchange needs to run guest start and refresh: `kms:Sign` on the signing key
 *    alone, the switch, the salt, the captcha secret it names (never created here, never read at synth),
 *    the guest-session role, setting a visitor's expiration, and raising an alert.
 *
 * ── THE GUEST-SESSION BOUNDARY (§5) ──────────────────────────────────────────────────────────────
 *
 * The role a visitor's session is on reaches ONE conversation, by construction rather than by the session
 * policy alone. Its trust requires three session tags: `person` (the visitor's AppInstanceUser), `channel`
 * (their conversation's id) and `classification` (the guest classification). Its policy, and its
 * permissions boundary, name the channel as `channel/${aws:PrincipalTag/channel}` with its
 * `classification` tag required to be the guest's, and the bearer as `user/${aws:PrincipalTag/person}`.
 * So, assumed with no session policy at all, the role reaches the one conversation its session was
 * tagged with, as the one visitor, with the read-and-post set, and nothing else: no `CreateChannel`, no
 * `CreateChannelMembership`, no other channel and no model. The exchange's session policy narrows the
 * same set again, and Amazon Chime SDK membership is the layer under both.
 */
import { conversationCreatorArnKey, CONVERSATION_CREATOR_PARAM_ROOT } from './conversation-creator';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { guestIssuerUri, guestSettingsOf, type IssuerConfig } from '../config/issuers';
import { dataRemovalPolicy, environmentOf } from '../config/environment';
import {
  INSTANCE_NAME,
  RES_PREFIX,
  SHARED_SSM,
  alertEmitterWiring,
  archivedChannelReadOnlyDeny,
  guestKillSwitchParameter,
} from '../stacks/agent-classification-common';
import type { RouteSpec, RouteThrottle } from './http-api';

/** The read-and-post set a guest session holds on its one conversation, and nothing more. */
export const GUEST_SESSION_ACTIONS = [
  'chime:GetChannelMessage',
  'chime:ListChannelMessages',
  'chime:DescribeChannel',
  'chime:ListChannelMemberships',
  'chime:SendChannelMessage',
  'chime:UpdateChannelReadMarker',
] as const;

/** Guest start: a tight throttle for the whole route, every caller together (L16). */
export const GUEST_START_THROTTLE: RouteThrottle = { rate: 5, burst: 10 };
/** Guest refresh: every visitor rotates about once a token lifetime. */
export const GUEST_REFRESH_THROTTLE: RouteThrottle = { rate: 20, burst: 40 };

export interface GuestIssuerProps {
  /** The registry's guest entry. */
  entry: IssuerConfig;
  appInstanceArn: string;
  /** The credential exchange's role and function: guest start and refresh run there. */
  exchangeRole: iam.Role;
  exchangeFunction: lambda.Function;
}

export class GuestIssuer extends Construct {
  /** Each key generation's KMS key ARN, by `kid`. */
  readonly signingKeys: Record<string, string>;
  /** The guest-session role a visitor's credential is on. */
  readonly sessionRole: iam.Role;
  /** Its permissions boundary. */
  readonly sessionBoundary: iam.ManagedPolicy;
  /** Guest start and guest refresh, on `PersonApi`, with no authorizer and a route throttle each. */
  readonly routes: RouteSpec[];
  /** The kill switch's SSM parameter name. */
  readonly killSwitchParameter: string;
  /** The privacy-notice version guest start records as shown. */
  readonly noticeVersion: string;
  /** The captcha site key the widget loads (the vendor's test key outside production when none is declared). */
  readonly captchaSiteKey: string;

  constructor(scope: Construct, id: string, props: GuestIssuerProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const { entry, appInstanceArn, exchangeRole, exchangeFunction } = props;
    const settings = guestSettingsOf(entry);
    const classification = (entry.clearance as { fixed: string[] }).fixed[0];

    // ── THE SIGNING KEYS ─────────────────────────────────────────────────────────────────────────
    const keys: Record<string, kms.Key> = {};
    for (const kid of settings.signingKeys) {
      keys[kid] = new kms.Key(this, `SigningKey${kid.toUpperCase()}`, {
        keySpec: kms.KeySpec.ECC_NIST_P256,
        keyUsage: kms.KeyUsage.SIGN_VERIFY,
        description: `${INSTANCE_NAME} guest issuer "${entry.id}" signing key, generation ${kid}. Rotation: docs/guides/admin/GUEST-ISSUER.md`,
        alias: `alias/${RES_PREFIX}-guest-${entry.id}-${kid}`,
        // Deleted with a dev teardown after KMS's shortest pending window; kept in production.
        removalPolicy: dataRemovalPolicy(this),
        pendingWindow: cdk.Duration.days(7),
      });
    }
    this.signingKeys = Object.fromEntries(Object.entries(keys).map(([kid, k]) => [kid, k.keyArn]));
    const signingKid = settings.signingKeys[settings.signingKeys.length - 1];
    // SIGN ON THE CURRENT GENERATION ONLY: an old key verifies for one token lifetime and signs nothing.
    exchangeRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'GuestTokenSign',
      actions: ['kms:Sign'],
      resources: [keys[signingKid].keyArn],
    }));

    // ── THE KILL SWITCH AND THE SALT ─────────────────────────────────────────────────────────────
    const killSwitchName = guestKillSwitchParameter(entry.id);
    this.killSwitchParameter = killSwitchName;
    this.noticeVersion = settings.noticeVersion;
    this.captchaSiteKey = settings.captcha.siteKey;
    new ssm.StringParameter(this, 'KillSwitch', {
      parameterName: killSwitchName,
      description: `Pauses guest start for issuer "${entry.id}": {"paused": true|false, "changedBy", "changedAt", "reason"}. Change it with scripts/guest-switch.mjs.`,
      // CONSTANT, so a redeploy never resets a switch an operator has set: CloudFormation writes the value
      // only when the template's changes.
      stringValue: JSON.stringify({ paused: false, changedBy: 'deploy', changedAt: 'initial' }),
    });
    const salt = new secretsmanager.Secret(this, 'AddressSalt', {
      description: `The salt guest start hashes a source address with for issuer "${entry.id}"; never the address itself`,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: dataRemovalPolicy(this),
    });
    salt.grantRead(exchangeRole);

    // ── WHAT THE EXCHANGE READS AT RUNTIME ───────────────────────────────────────────────────────
    const parameterArn = (name: string) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${name}`;
    exchangeRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'GuestControlsRead',
      actions: ['ssm:GetParameter'],
      resources: [
        parameterArn(killSwitchName),
        // In Conversations, which deploys after this stack: read by name at runtime. A classification's
        // creator is read under its own key, granted where the invoke is (`conversationCreatorInvoke`).
        parameterArn(SHARED_SSM.tokensName),
        parameterArn(SHARED_SSM.abuseControlsName),
        ...(settings.captcha.secretParameter ? [parameterArn(settings.captcha.secretParameter)] : []),
      ],
    }));
    if (settings.captcha.secretName) {
      // THE CAPTCHA SECRET IS NAMED, never created or read here: the operator stores it.
      exchangeRole.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'GuestCaptchaSecretRead',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${settings.captcha.secretName}-??????`],
      }));
    }
    // A VISITOR EXPIRES (the minter creates them; this sets their expiration).
    exchangeRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'GuestExpiration',
      actions: ['chime:PutAppInstanceUserExpirationSettings'],
      resources: [`${appInstanceArn}/user/*`],
    }));
    const alerts = alertEmitterWiring(this);
    alerts.grant(exchangeRole);

    // ── THE GUEST-SESSION ROLE, UNDER ITS BOUNDARY ───────────────────────────────────────────────
    const pinnedUser = `${appInstanceArn}/user/` + '${aws:PrincipalTag/person}';
    const pinnedChannel = `${appInstanceArn}/channel/` + '${aws:PrincipalTag/channel}';
    const sessionStatements = (): iam.PolicyStatement[] => [
      new iam.PolicyStatement({ sid: 'SessionEndpoint', actions: ['chime:GetMessagingSessionEndpoint'], resources: ['*'] }),
      new iam.PolicyStatement({ sid: 'ConnectAsTheVisitor', actions: ['chime:Connect'], resources: [pinnedUser] }),
      new iam.PolicyStatement({
        sid: 'TheirOneConversation',
        actions: [...GUEST_SESSION_ACTIONS],
        resources: [pinnedChannel],
        conditions: { StringEquals: { 'aws:ResourceTag/classification': classification } },
      }),
      new iam.PolicyStatement({ sid: 'AsTheVisitor', actions: [...GUEST_SESSION_ACTIONS], resources: [pinnedUser] }),
    ];
    this.sessionBoundary = new iam.ManagedPolicy(this, 'SessionBoundary', {
      description: `The boundary of a guest session (issuer "${entry.id}"): one conversation, read and post, as the visitor`,
      statements: sessionStatements(),
    });
    const tagPin = {
      StringLike: { 'aws:RequestTag/person': '*', 'aws:RequestTag/channel': '*' },
      StringEquals: { 'aws:RequestTag/classification': classification },
    };
    this.sessionRole = new iam.Role(this, 'SessionRole', {
      assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(exchangeRole.roleArn), tagPin),
      permissionsBoundary: this.sessionBoundary,
      description: `A guest's session (issuer "${entry.id}"): their one conversation, read and post, as themselves`,
    });
    this.sessionRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      principals: [new iam.ArnPrincipal(exchangeRole.roleArn)],
      actions: ['sts:TagSession'],
      conditions: tagPin,
    }));
    for (const st of sessionStatements()) this.sessionRole.addToPolicy(st);
    this.sessionRole.addToPolicy(archivedChannelReadOnlyDeny(appInstanceArn));
    exchangeRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'GuestSessionAssume',
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [this.sessionRole.roleArn],
    }));

    // ── THE EXCHANGE'S GUEST CONFIGURATION ───────────────────────────────────────────────────────
    exchangeFunction.addEnvironment('GUEST_CONFIG', stack.toJsonString({
      issuerId: entry.id,
      classification,
      issuerUri: guestIssuerUri(INSTANCE_NAME, entry.id),
      deploymentId: INSTANCE_NAME,
      settings,
      signingKeyArn: keys[signingKid].keyArn,
      signingKid,
      killSwitchParameter: killSwitchName,
      addressSaltSecret: salt.secretArn,
      guestRoleArn: this.sessionRole.roleArn,
      tokensTableParameter: SHARED_SSM.tokensName,
      abuseTableParameter: SHARED_SSM.abuseControlsName,
      // The visitor classification's creator, and the root a bind finds the account classification's under.
      creatorParameter: conversationCreatorArnKey(classification),
      creatorParameterRoot: CONVERSATION_CREATOR_PARAM_ROOT,
      environment: environmentOf(this),
    }));
    for (const [k, v] of Object.entries(alerts.env)) exchangeFunction.addEnvironment(k, v);

    this.routes = [
      { api: 'person', method: 'POST', path: '/guest/start', handler: exchangeFunction, capability: 'core', auth: 'none', throttle: GUEST_START_THROTTLE },
      { api: 'person', method: 'POST', path: '/guest/refresh', handler: exchangeFunction, capability: 'core', auth: 'none', throttle: GUEST_REFRESH_THROTTLE },
    ];

    // ── THE ALARMS ───────────────────────────────────────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'SigningThrottledAlarm', {
      alarmName: `${stack.stackName}-guest-signing-throttled`,
      alarmDescription: 'KMS throttled a guest token Sign. The request quota is shared with every key in this account and region, '
        + 'so guest start is refusing visitors with `unavailable` until it clears. See docs/guides/admin/GUEST-ISSUER.md.',
      metric: new cloudwatch.Metric({
        namespace: 'AgentEchelon/Guest', metricName: 'GuestSigningThrottled', statistic: 'Sum',
        period: cdk.Duration.minutes(5), dimensionsMap: { Instance: INSTANCE_NAME },
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'UnavailableAlarm', {
      alarmName: `${stack.stackName}-guest-unavailable`,
      alarmDescription: 'Guest start or refresh refused a visitor because a control could not answer (the kill switch, the limit '
        + 'store, the captcha verifier, the token store or the signing key). Every control fails closed.',
      metric: new cloudwatch.Metric({
        namespace: 'AgentEchelon/Guest', metricName: 'GuestRefused', statistic: 'Sum',
        period: cdk.Duration.minutes(5), dimensionsMap: { Instance: INSTANCE_NAME, Reason: 'unavailable' },
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
