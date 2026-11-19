/**
 * A MESSAGE'S `Target` AND WHAT THE MESSAGE SAYS ABOUT ITSELF MUST AGREE.
 *
 * Who can see a message is the `Target` Amazon Chime SDK set and enforces. Two other things say who a message was meant
 * for: the private address at its start (`.<Name|id>`, which the composer writes for a private send) and the recipient
 * an assistant stamps beside its private reply (`targetedSender` in the Metadata of a message an assistant sent). When
 * either names somebody the `Target` does not, the message did not go where it says it went, and that is shown as an
 * error on the message and refused at the send, never read past.
 *
 * Only what the platform wrote is compared: the composer's own token, and Metadata on a message whose service-stamped
 * sender is an assistant. A person's Metadata says nothing here, so no member can raise or hide this error for another.
 */
import { encodedPrivateAddress, leadingPrivateAddress, type ComposerDraft } from './composerMentions';

/**
 * THE MARKER EVERY TARGET-MISMATCH ERROR IS LOGGED UNDER. The e2e suite fails any test whose page logs it without declaring
 * it (`tests/e2e/helpers/fixtures.ts`), so the client's check is watched in every run; it is the platform's own token,
 * never words.
 */
export const TARGET_MISMATCH_LOG = '[target-mismatch]';

/** How a message disagrees with its `Target`. */
export type TargetMismatch =
  /** It opens with a private address to a member its `Target` does not name. */
  | 'address'
  /** An assistant stamped it for a person its `Target` does not name. */
  | 'assistant';

/** The member id a leading private address carries, when it carries one (the token grammar of `composerMentions.ts`). */
export function privateAddressId(text: string): string | undefined {
  return encodedPrivateAddress(text)?.id;
}

const namesId = (arn: string, id: string) => arn === id || arn.endsWith(`/${id}`);

/**
 * The disagreement on a message this client received, or undefined where its `Target` and its own words agree.
 * `targetArns` is the `Target` as the service delivered it (empty for a message the room reads).
 */
export function receivedTargetMismatch(args: {
  /** The message text as sent, before any display cleaning. */
  text: string;
  metadata: Record<string, unknown>;
  targetArns: readonly string[];
  /** The service-stamped sender is an assistant, so its Metadata is the platform's. */
  senderIsAssistant: boolean;
}): TargetMismatch | undefined {
  const id = privateAddressId(args.text);
  if (id && !args.targetArns.some((arn) => namesId(arn, id))) return 'address';
  const stamped = args.senderIsAssistant && typeof args.metadata.targetedSender === 'string' ? args.metadata.targetedSender : '';
  if (stamped && !args.targetArns.includes(stamped)) return 'assistant';
  return undefined;
}

const idOf = (arn: string) => arn.split('/').pop() ?? '';

/**
 * THE MEMBERS A DRAFT READS AS PRIVATELY ADDRESSED TO, by the rule the composer places addresses by
 * (`leadingPrivateAddress`): a leading `.` and then a member's whole name, the longest that fits. A member the person
 * PICKED is read by the id the pick carries, so two members sharing a name (or a member sharing the sender's) are told
 * apart; a name typed by hand reads as every member who carries it. Empty when the draft is no private address.
 */
export function draftReadsAsPrivateTo<M extends { userArn: string; name?: string }>(
  field: ComposerDraft | string,
  members: readonly M[],
): M[] {
  const draft: ComposerDraft = typeof field === 'string' ? { text: field, mentions: [] } : field;
  const lead = leadingPrivateAddress(draft, members.map((m) => m.name ?? ''));
  if (!lead) return [];
  const picked = draft.mentions.find((m) => m.start === lead.start && m.token.startsWith('.'));
  const written = picked?.token ?? draft.text.slice(lead.start, lead.end);
  const token = encodedPrivateAddress(written);
  if (token?.id) {
    const byId = members.filter((m) => idOf(m.userArn) === token.id);
    if (byId.length) return byId;
  }
  const name = (token ? token.name : draft.text.slice(lead.start + 1, lead.end)).trim().toLowerCase();
  return members.filter((m) => !!name && m.name?.trim().toLowerCase() === name);
}

/**
 * Whether a send must be refused: the field reads as private to a member, and the send would target none of the members
 * it reads as. `targetArn` is the `Target` the send will carry (undefined for a message to the room). Answers the member
 * named in the refusal.
 */
export function sendTargetMismatch<M extends { userArn: string; name?: string }>(
  field: ComposerDraft | string,
  members: readonly M[],
  targetArn: string | undefined,
): M | undefined {
  const reads = draftReadsAsPrivateTo(field, members);
  return reads.length && !reads.some((m) => m.userArn === targetArn) ? reads[0] : undefined;
}
