/**
 * THE TOKEN STORE'S GRANTS (A8): each writer reaches its own token kinds and no other.
 *
 * `Tokens` (`conversations-stack.ts`) keys every record `<kind>#<sha256(token)>`
 * (`lambda/src/lib/tokens.ts`), so a grant conditioned on `dynamodb:LeadingKeys` matching `<kind>#*`
 * reaches exactly that kind's records: the exchange that writes `guest-refresh#...` is refused an
 * `invitation#...` by IAM, before any handler runs, and a role with no grant here reaches nothing at all.
 *
 * `ForAllValues:StringLike`, the form DynamoDB's own fine-grained access control uses: every key a
 * request touches must match one of the kinds, and a request naming a key outside them is refused whole.
 */
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { TOKEN_KINDS, type TokenKind } from '../../lambda/src/lib/tokens';
import { INVITATIONS_BY_CHANNEL, INVITATION_RECORD_ATTRIBUTES } from '../../lambda/src/lib/invitations';

/** The `dynamodb:LeadingKeys` patterns for a set of token kinds. */
export function leadingKeysFor(kinds: readonly TokenKind[]): string[] {
  for (const k of kinds) if (!TOKEN_KINDS[k]) throw new Error(`token-store: "${String(k)}" is not a token kind`);
  return kinds.map((k) => `${k}#*`);
}

/**
 * READ A CONVERSATION'S INVITATIONS through the sparse index that lists them (`INVITATIONS_BY_CHANNEL`), and nothing
 * else of the store: `Query` on the index alone, never a record by its key and never a write, so the holder can neither
 * read a token of another kind, nor redeem, revoke or issue an invitation. The membership audit and each classification's
 * router (which verifies `invitation-sent`, ADR-061 decision 1) hold it.
 */
export function invitationIndexReadStatement(tokensTableArn: string, sid = 'ReadAConversationsInvitations'): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid,
    actions: ['dynamodb:Query'],
    resources: [`${tokensTableArn}/index/${INVITATIONS_BY_CHANNEL}`],
  });
}

/**
 * READ ONE INVITATION BY ITS KEY, STRONGLY CONSISTENT, and only the attributes verifying its event needs
 * (`INVITATION_RECORD_ATTRIBUTES`). `GetItem` alone, on keys of kind `invitation` alone (`dynamodb:LeadingKeys`
 * `invitation#*`), with the attributes named and a projection required (`dynamodb:Select` `SPECIFIC_ATTRIBUTES`), so the
 * holder reads no token of another kind, no attribute beyond those, and writes nothing.
 *
 * WHY A KEY READ BESIDE THE INDEX: the index is eventually consistent, and the router verifies `invitation-sent` the moment
 * after the invitation is written, so an index read can miss a record that exists and refuse a real event. Reading by the
 * key reaches no record the index does not already show the router: the index projects every attribute of every
 * invitation, and an invitation's key is its token's hash, which grants nothing. Each classification's router holds it.
 */
export function invitationRecordReadStatement(tokensTableArn: string, sid = 'ReadAnInvitationByItsKey'): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid,
    actions: ['dynamodb:GetItem'],
    resources: [tokensTableArn],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': leadingKeysFor(['invitation']) },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...INVITATION_RECORD_ATTRIBUTES] },
      StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    },
  });
}

/** Grant `actions` on `table` to `grantee`, for the records of `kinds` alone. */
export function grantTokenKinds(
  table: dynamodb.ITable,
  grantee: iam.IRole,
  kinds: readonly TokenKind[],
  actions: readonly string[],
): void {
  if (!kinds.length) throw new Error('token-store: a grant names the token kinds it reaches');
  grantee.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: `TokenKinds${kinds.map((k) => k.replace(/[^A-Za-z0-9]/g, '')).join('')}`.slice(0, 100),
    actions: [...actions],
    resources: [table.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': leadingKeysFor(kinds) } },
  }));
}
