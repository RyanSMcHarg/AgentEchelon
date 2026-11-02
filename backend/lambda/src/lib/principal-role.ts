/**
 * WHAT KIND OF PRINCIPAL THIS IS - the role axis, which is not the clearance axis.
 *
 * A turn has two independent facts about whoever sent it:
 *
 *   ROLE       what kind of principal they are - a person, an administrator acting on the admin
 *              plane, an assistant. Structural. It does
 *              not move, and it is legible in the ARN itself.
 *   CLEARANCE  what classifications they reach. Mutable, point-in-time, and recorded separately as
 *              `messages.user_clearance` precisely because it moves.
 *
 * Analytics recorded the second and not the first, and `is_bot` was the whole of what it knew about
 * the first. So "how many turns came from the admin plane" had no answer, while `user_type` sat at the literal string 'unknown' on 198 of 200 rows.
 *
 * ── DERIVED FROM THE ARN, AND THAT IS WHY IT CAN BE DERIVED LATE ────────────────────────────────
 *
 * Every rule here reads the ARN's own shape: whether it names a `/user/` or a `/bot/`, whether the id
 * is the deployment's admin identity or an admin-plane twin. None of that changes
 * after the fact, so unlike a clearance this may be resolved when a row is archived rather than
 * declared by the producer - a late pairing and a live one reach the same answer.
 *
 * ── ONE DEFINITION, TWO CALLERS ─────────────────────────────────────────────────────────────────
 *
 * This lived inside `membership-audit.ts`, which loads Amazon Chime SDK, Cognito, SSM, DynamoDB and
 * Lambda clients at module scope - so archival could not import it without dragging all of them into
 * an unrelated handler, and a second copy was the obvious shortcut. Two principal taxonomies that
 * disagree is exactly the class of drift the classification work spent this session removing, so it
 * moved here instead: pure, client-free, and imported by both.
 */
import { adminTwinOwnerId, personIdFromArn } from './person-arn.js';

/**
 * The roles a principal can have.
 *
 * WHICH ISSUER SIGNED A PERSON IN IS NOT A ROLE. It lives only in `Identities`, and a person id is an
 * opaque UUID v7 that says nothing about it, so a person of any issuer is a `user` here. A deployment
 * that declares a guest classification should add the role beside it, in one place.
 */
export type PrincipalRole = 'user' | 'bot' | 'admin' | 'unknown';

/**
 * The role of the principal an ARN names, and the sub inside it when there is one.
 *
 * `owner` is set for an admin-plane twin: the person id of the human it belongs to, so a reader
 * attributes the twin's actions to its owner. It is read through `adminTwinOwnerId` because this runs
 * where the twin's `owner` tag cannot be read (archival has no route to the Amazon Chime SDK).
 *
 * `unknown` means the ARN could not be read - absent, or naming no principal. It is never a guess and
 * no reader may treat it as a default: a row carrying it is a row whose sender could not be
 * identified, which is a defect to chase.
 */
export function classifyPrincipal(
  principalArn: string | undefined,
  adminUserId: string,
): { kind: PrincipalRole; sub: string | null; owner?: string } {
  if (!principalArn) return { kind: 'unknown', sub: null };
  // `/bot/...` or any non-user principal. An assistant is a bot whatever else the ARN says.
  if (!principalArn.includes('/user/')) return { kind: 'bot', sub: null };
  const sub = personIdFromArn(principalArn);
  if (!sub) return { kind: 'unknown', sub: null };
  // THE ADMIN PLANE IS AN IDENTITY, not a flag on a person. The `${personId}-admin` identity and the
  // deployment's own admin user are the principals that act across conversations; a person's chat
  // identity is never elevated, so it never matches here.
  if (sub === adminUserId) return { kind: 'admin', sub };
  const owner = adminTwinOwnerId(sub, adminUserId);
  if (owner) return { kind: 'admin', sub, owner };
  return { kind: 'user', sub };
}
