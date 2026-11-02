/**
 * WHERE A PERSON'S CLEARANCE GROUPS COME FROM - the one identity-provider-specific step, behind a seam.
 *
 * ── WHY THIS EXISTS (owner decision 2026-09-14) ────────────────────────────────────────
 *
 * `user-clearance.ts` called `AdminListGroupsForUser` directly, on the live request path for both the
 * router and the channel flow, with no seam at all. Meanwhile IDENTITY-PROVIDER-GUIDE said two
 * opposite things: enforce at the AppInstanceUser and assumed-role layer and NEVER on
 * Cognito-specific signals (because enforcing on groups directly locks out every non-Cognito user),
 * and also that authorization checks trust Cognito group membership as the authoritative signal.
 * Step 7 of that guide papered over the gap by telling integrators to mirror their claim into a
 * Cognito group.
 *
 * NOT SPECULATIVE GENERALITY, WHICH IS THE USUAL OBJECTION TO AN INTERFACE WITH ONE IMPLEMENTATION.
 * A second model already exists: a person of another issuer does not exist in the pool at all, and
 * their entitlement is the channel they were provisioned into. That is two clearance models, which is
 * the evidence that the seam was missing rather than the argument that one might be wanted later. The
 * adapter is asked by SUBJECT; the person's subject in this pool is found through `Identities`
 * (`Directory.groupsFor`, `lib/membership-source.ts`), and a person with none there is reported as
 * such rather than asked.
 *
 * ── WHAT IS AND IS NOT BEHIND THE SEAM ──────────────────────────────────────────────────────────
 *
 * Behind it: "which groups does this subject hold", the only provider-specific question.
 *
 * NOT behind it: what those groups MEAN. That is the registry's job and it is provider-neutral -
 * `resolveHolderToken` takes the union of what the held groups clear for and returns the declared
 * classification whose grant set IS that union. An adapter that returned a classification rather than
 * groups would move policy into the provider, which is the mistake this seam exists to prevent: the
 * deployment decides what a group means, not the directory it came from.
 *
 * COGNITO IS ONE SOURCE OF FOUR. A pool's groups are what a `groups` source reads, through this
 * provider; a `mapping`, a `fixed` set and the one-conversation session are sources of their own (below),
 * chosen per issuer by the seam factory (`lib/issuer-seams.ts`).
 */
import {
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';
import { bySubjectOrUsername } from './cognito-pool-directory.js';

/**
 * The groups a subject holds, as the identity provider reports them.
 *
 * Returns the RAW group names. An empty array is a real answer - a subject who holds no clearance
 * group - and is distinct from a failure, which throws. The caller decides what an empty set means;
 * conflating "holds nothing" with "could not ask" is what fail-open bugs are made of.
 */
export interface ClearanceSource {
  /** Group names for this subject. Throws if the provider could not be asked. */
  groupsFor(subject: string): Promise<string[]>;
  /** For logs and errors, so a failure names which provider failed. */
  readonly name: string;
}

/**
 * The shipped adapter: Amazon Cognito user-pool groups, server-verified.
 *
 * Reads the pool rather than the caller's `cognito:groups` claim on purpose - a claim is shaped by
 * group-resource precedence and can be truncated, while this is the authoritative list.
 */
export class CognitoClearanceSource implements ClearanceSource {
  readonly name = 'cognito';

  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
  ) {}

  async groupsFor(subject: string): Promise<string[]> {
    // A federated person is addressed by their pool username, never their `sub` (`bySubjectOrUsername`).
    const resp = await bySubjectOrUsername(this.client, this.userPoolId, subject, (Username) => this.client.send(
      new AdminListGroupsForUserCommand({ UserPoolId: this.userPoolId, Username }),
    ));
    return (resp.Groups || []).map((g) => g.GroupName || '').filter(Boolean);
  }
}

/** The pool client a clearance read is made with: the function's own role, bounded. */
export function clearanceClient(): CognitoIdentityProviderClient {
  return sessionClient(CognitoIdentityProviderClient, { region: process.env.AWS_REGION || 'us-east-1', requestHandler: BOUNDED_REQUEST_HANDLER });
}

// ── ONE SOURCE PER Q5 CLEARANCE SOURCE ───────────────────────────────────────────────────────────
//
// Each trusted issuer declares where its people's clearance comes from (`clearance` in the registry,
// `lib/config/issuers.ts`): its pool's groups, a claim mapping, a fixed set, or the one-conversation
// session. Each is one implementation of `IssuerClearanceSource`, chosen once per issuer by the seam
// factory (`lib/issuer-seams.ts`). A source answers in its OWN terms - group names, or the
// classifications its configuration names - and never applies the issuer's classifications or picks a token: what the
// answer means is the registry's (`heldWithinIssuer`, `Directory.clearanceOf`).

/** What a source says a subject holds, in the source's own terms. */
export type HeldBySource =
  | { groups: string[] }
  | { classifications: string[] };

export interface IssuerClearanceSource {
  /** Which Q5 source this is, for logs and errors. */
  readonly source: 'groups' | 'mapping' | 'fixed' | 'oneChannel';
  readonly issuerId: string;
  /**
   * What the subject holds, read without a token (the membership audit, the reconcile, the router).
   * Null when this source decides only from a token the person presents, so offline there is nothing to
   * read and the caller treats the clearance as undetermined. Throws when the source could not be asked.
   */
  heldFor(subject: string): Promise<HeldBySource | null>;
}

/** `groups: true`: the issuer's pool's own groups, read live through the provider. */
export function groupsClearanceSource(issuerId: string, provider: ClearanceSource): IssuerClearanceSource {
  return {
    source: 'groups',
    issuerId,
    async heldFor(subject) {
      return { groups: await provider.groupsFor(subject) };
    },
  };
}

/**
 * `groups` as a translation: a provider's groups, mapped into AgentEchelon groups. They arrive on the
 * person's verified token alone, so offline the source has no answer: undetermined, never a guess and never
 * a floor. The token-time half is `groupsOf` (`lib/config/issuers.ts`).
 */
export function translatedGroupsClearanceSource(issuerId: string): IssuerClearanceSource {
  return { source: 'groups', issuerId, heldFor: async () => null };
}

/**
 * `mapping`: a claim's values, mapped. The claim arrives on the person's verified token and nowhere else
 * this deployment reads, so offline the source has no answer: it is undetermined, never a guess and never
 * a floor. The token-time half is `holderTokenOf` (`lib/config/issuers.ts`), read at the edge.
 */
export function mappingClearanceSource(issuerId: string): IssuerClearanceSource {
  return { source: 'mapping', issuerId, heldFor: async () => null };
}

/** `fixed`: the set the issuer declares, whoever the subject is. */
export function fixedClearanceSource(issuerId: string, classifications: readonly string[]): IssuerClearanceSource {
  return { source: 'fixed', issuerId, heldFor: async () => ({ classifications: [...classifications] }) };
}

/** `oneChannel`: the one classification the issuer's people reach their one conversation at. */
export function oneChannelClearanceSource(issuerId: string, classification: string): IssuerClearanceSource {
  return { source: 'oneChannel', issuerId, heldFor: async () => ({ classifications: [classification] }) };
}
