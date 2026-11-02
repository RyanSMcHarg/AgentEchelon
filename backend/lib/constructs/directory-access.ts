/**
 * WHAT A FUNCTION NEEDS TO ASK THE DIRECTORY ABOUT A PERSON, AND TO EMAIL ONE.
 *
 * `Directory` (`lambda/src/lib/membership-source.ts`) answers by AppInstanceUser: it reaches a person's
 * issuer subjects through the `Identities` table's `byPerson` index, and a subject's person through a
 * row read and an AppInstanceUser describe, then asks the issuer's pool. So a function that names,
 * reaches, finds or clears people is given exactly that: the table's name, `Query` on the index and
 * `GetItem` on the table (nothing that writes it), `chime:DescribeAppInstanceUser` on this instance's
 * users, and the pool reads it names, on the pools it is told to trust.
 *
 * THE EMAIL FAN-OUT IS GRANTED HERE AND NOWHERE ELSE (`grantEmailFanOut`): `ses:SendEmail` on the sender
 * identity, with the directory reads the fan-out resolves contacts through. A second hand-written SES
 * statement is how one path came to be scoped to the address while SES authorized against the domain.
 * With it, everything a mail needs before it may go (`lib/email-consent.ts`): the recipient's preferences
 * (`<personId>#notices` items of the user-profile table, read only), the token store for the mail's
 * unsubscribe and reply tokens (`PutItem` on `unsubscribe#*` and `reply#*` only), the person API's URL
 * for the preference link, and, for a mail about a conversation, the reads that find its assistant's
 * voice (`lib/email-copy.ts`). A function cannot be granted the send without them.
 */
import { TEMPLATES_PREFIX } from '../../lambda/src/lib/template-store';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib';
import { SHARED_SSM, SSM_ROOT, roomPrimaryReadStatements, EVERY_CLASSIFICATION } from '../stacks/agent-classification-common';
import { sesSenderIdentityArns } from '../ses-identity';
import { grantIssuerRegistry, issuersOf } from './trusted-issuers';
import { contactCopiesDeclared, grantContactCopyRead } from './contact-copy';
import { leadingKeysFor } from './token-store';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { directoryOf } from '../config/issuers';
import type { Construct } from 'constructs';

/** The pool reads a directory question needs. Named per caller, so each function holds only its own. */
export type PoolRead = 'cognito-idp:AdminGetUser' | 'cognito-idp:ListUsers' | 'cognito-idp:ListUsersInGroup' | 'cognito-idp:AdminListGroupsForUser';

export interface DirectoryAccess {
  appInstanceArn: string;
  /** This deployment's own pool: the issuer whose groups are clearances. */
  userPoolId: string;
  /** Other trusted pools, for names and contacts. */
  additionalPoolIds?: string[];
  /** The pool reads this function makes. */
  poolReads: PoolRead[];
  /**
   * The table itself, for a function in the stack that owns it. Otherwise the name and ARN come from the
   * SSM contract Identity publishes, which a stack in the same deployment reads at deploy time.
   */
  identities?: { tableName: string; tableArn: string };
  /**
   * Attach the statements as their own managed policy rather than to the role's default policy, for a
   * role whose inline policies are near IAM's 10,240-byte cap (the per-classification router).
   */
  managed?: boolean;
}

/** The pool reads that address one account by subject, and so may resolve a federated one through ListUsers. */
const readsOneAccount = (a: PoolRead): boolean => a === 'cognito-idp:AdminGetUser' || a === 'cognito-idp:AdminListGroupsForUser';

export function grantDirectoryRead(fn: lambda.Function, access: DirectoryAccess): void {
  const stack = cdk.Stack.of(fn);
  const tableName = access.identities?.tableName ?? ssm.StringParameter.valueForStringParameter(fn, SHARED_SSM.identitiesName);
  const tableArn = access.identities?.tableArn ?? ssm.StringParameter.valueForStringParameter(fn, SHARED_SSM.identitiesArn);
  // EVERY POOL THE REGISTRY TRUSTS (C1): the directory asks each issuer's own pool, so the reads reach
  // each Cognito entry's pool, this deployment's own resolved from `self`.
  const registryPools = issuersOf(fn).entries.filter((e) => e.kind === 'cognito-pool' || e.kind === 'cognito-federated')
    .map((e) => (e.pool === 'self' ? '' : e.pool || ''));
  const others = [...new Set([...(access.additionalPoolIds || []), ...registryPools].filter((id) => id && id !== access.userPoolId))];
  fn.addEnvironment('IDENTITIES_TABLE', tableName);
  fn.addEnvironment('APP_INSTANCE_ARN', access.appInstanceArn);
  fn.addEnvironment('USER_POOL_ID', access.userPoolId);
  // The registry the directory keys a pool's subjects by (each pool's registry id, lib/config/issuers.ts).
  grantIssuerRegistry(fn, access.userPoolId);
  const statements = [
    new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [tableArn, `${tableArn}/index/byPerson`],
    }),
    new iam.PolicyStatement({
      actions: ['chime:DescribeAppInstanceUser'],
      resources: [`${access.appInstanceArn}/user/*`],
    }),
    ...(access.poolReads.length && (access.userPoolId || others.length) ? [new iam.PolicyStatement({
      // A READ OF ONE ACCOUNT BY SUBJECT CAN NEED ListUsers: Cognito accepts a `sub` as `Username` for a local
      // user only, so a federated person is found by `ListUsers` on the `sub` attribute (`bySubjectOrUsername`,
      // cognito-pool-directory.ts). Without it, that read is AccessDenied rather than the person.
      actions: [...new Set([...access.poolReads, ...(access.poolReads.some(readsOneAccount) ? ['cognito-idp:ListUsers' as PoolRead] : [])])],
      resources: [access.userPoolId, ...others].filter(Boolean).map(
        (poolId) => `arn:aws:cognito-idp:${stack.region}:${stack.account}:userpool/${poolId}`,
      ),
    })] : []),
  ];
  // A FUNCTION THAT NAMES OR REACHES PEOPLE reads the contact copies of a `claims`-directory issuer (C5).
  if (access.poolReads.includes('cognito-idp:AdminGetUser') && contactCopiesDeclared(fn)) grantContactCopyRead(fn);
  if (access.managed && fn.role) {
    fn.role.addManagedPolicy(new iam.ManagedPolicy(fn, 'DirectoryRead', { statements }));
    return;
  }
  for (const statement of statements) fn.addToRolePolicy(statement);
}

/**
 * THE POOLS AN ACCOUNT'S STATE IS ASKED OF: every pool a Cognito registry entry reads through the
 * `cognito` directory, this deployment's own resolved from `self` (`''` when it has none). Exactly these,
 * so a role that asks whether an account may sign in reaches no other pool.
 */
export function accountStatePoolIds(scope: Construct, selfPoolId: string): string[] {
  return [...new Set(issuersOf(scope).entries
    .filter((e) => (e.kind === 'cognito-pool' || e.kind === 'cognito-federated') && directoryOf(e) === 'cognito')
    .map((e) => (e.pool === 'self' ? selfPoolId : e.pool || ''))
    .filter(Boolean))];
}

/**
 * WHETHER AN ACCOUNT MAY STILL SIGN IN, asked of its issuer's pool live (`Directory.accountState`,
 * SPEC-CREDENTIAL-EXCHANGE §4b, "An account disabled at its issuer"). `AdminGetUser` reads the account's
 * `Enabled`; `ListUsers` finds a federated person's pool username from their `sub` (`bySubjectOrUsername`).
 * Granted to the credential exchanges, which ask at every vend, and to user management, whose list of
 * people reads `enabled` the same way. Nothing is granted when the registry declares no Cognito entry.
 */
export function grantAccountStateRead(scope: Construct, grantee: iam.IGrantable, selfPoolId: string): void {
  const pools = accountStatePoolIds(scope, selfPoolId);
  if (!pools.length) return;
  const stack = cdk.Stack.of(scope);
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'AskTheIssuerWhetherTheAccountIsActive',
    actions: ['cognito-idp:AdminGetUser', 'cognito-idp:ListUsers'],
    resources: pools.map((poolId) => `arn:aws:cognito-idp:${stack.region}:${stack.account}:userpool/${poolId}`),
  }));
}

/** What every emailing function is given beside the send (B9, M-8). */
export interface EmailConsentAccess {
  /** The token store, for each mail's `unsubscribe` and `reply` tokens. */
  tokens: dynamodb.ITable;
  /** The user-profile table, whose `<personId>#notices` items hold each person's preferences. */
  preferencesTable: { tableName: string; tableArn: string };
  /** The reply subdomain, when the deployment receives replies; absent, no mail carries a reply address. */
  replyDomain?: string;
  /** Whether the function's mail is about conversations, so it reads the conversation assistant's voice. */
  conversationVoice: boolean;
  /**
   * The template store (the attachments bucket), where the conversation assistant's and its classification's
   * message templates are: a function with a conversation's voice reads them (ADR-062 decision 2).
   */
  templates?: { bucketName: string; bucketArn: string };
}

/** The one SES grant: the fan-out's send on the sender identity, with the directory reads it needs. */
export function grantEmailFanOut(
  fn: lambda.Function,
  access: Omit<DirectoryAccess, 'poolReads'> & { senderEmail: string; poolReads?: PoolRead[]; consent: EmailConsentAccess },
): void {
  grantEmailConsent(fn, access.consent);
  const stack = cdk.Stack.of(fn);
  grantDirectoryRead(fn, { ...access, poolReads: [...new Set(['cognito-idp:AdminGetUser' as PoolRead, ...(access.poolReads || [])])] });
  // The placeholder is what `lib/notification.ts` assumes when nothing is set, and it sends nothing; an
  // environment naming it would read as a configured sender to anything that discovers one.
  if (access.senderEmail && access.senderEmail !== 'noreply@example.com') fn.addEnvironment('SENDER_EMAIL', access.senderEmail);
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['ses:SendEmail'],
    // Scoped to the sender's identity ARNs - the address AND its parent domain, because SES authorizes
    // against whichever of the two it resolves the From address to. See lib/ses-identity.ts.
    resources: sesSenderIdentityArns(stack.region, stack.account, access.senderEmail),
  }));
}

/**
 * The consent, link and voice reads every emailing function needs (`lib/email-consent.ts`), as ONE MANAGED
 * POLICY on the function's role: the senders' inline policies are near IAM's per-role cap already (the
 * briefing's role holds the conversation creator's grants), and these statements are the same for every sender.
 */
function grantEmailConsent(fn: lambda.Function, consent: EmailConsentAccess): void {
  const stack = cdk.Stack.of(fn);
  fn.addEnvironment('NOTICE_PREFERENCES_TABLE', consent.preferencesTable.tableName);
  fn.addEnvironment('TOKENS_TABLE', consent.tokens.tableName);
  fn.addEnvironment('PERSON_API_URL_PARAM', SHARED_SSM.personApiUrl);
  if (consent.replyDomain) fn.addEnvironment('REPLY_DOMAIN', consent.replyDomain.trim().toLowerCase());
  const statements = [
    new iam.PolicyStatement({
      sid: 'ReadNoticePreferences',
      actions: ['dynamodb:GetItem'],
      resources: [consent.preferencesTable.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['*#notices'] } },
    }),
    // The mail's own unsubscribe and reply tokens, those two kinds only (the shape `grantTokenKinds` writes).
    new iam.PolicyStatement({
      sid: 'WriteEmailTokens',
      actions: ['dynamodb:PutItem'],
      resources: [consent.tokens.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': leadingKeysFor(['unsubscribe', 'reply']) } },
    }),
    new iam.PolicyStatement({
      sid: 'ReadThePersonApiUrl',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${SHARED_SSM.personApiUrl}`],
    }),
  ];
  if (consent.conversationVoice) {
    // THE CONVERSATION'S ASSISTANT AND ITS COPY: the room's primary from its tags and the assignment records,
    // and that assistant's active profile definition. Read only.
    fn.addEnvironment('SSM_ROOT', SSM_ROOT);
    statements.push(...roomPrimaryReadStatements(stack, EVERY_CLASSIFICATION), new iam.PolicyStatement({
      sid: 'ReadTheAssistantsCopy',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${SSM_ROOT}/assistant/*/definition`],
    }));
    // THE MESSAGE TEMPLATES THE EMAIL IS WORDED FROM (ADR-062): read-only, the template family and its pointers
    // and nothing else in the bucket. The function serves every classification's conversations, so the read
    // spans the classifications; which one it reads is the room's, resolved from the conversation it mails about.
    if (consent.templates) {
      fn.addEnvironment('TEMPLATE_BUCKET', consent.templates.bucketName);
      statements.push(
        new iam.PolicyStatement({
          sid: 'ReadTheMessageTemplates',
          actions: ['s3:GetObject'],
          resources: [`${consent.templates.bucketArn}/${TEMPLATES_PREFIX}/*`],
        }),
        new iam.PolicyStatement({
          sid: 'ReadTheMessageTemplatePointers',
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${SSM_ROOT}/assistant/*/templates/*`],
        }),
      );
    }
  }
  fn.role!.addManagedPolicy(new iam.ManagedPolicy(fn, 'EmailConsent', { statements }));
}
