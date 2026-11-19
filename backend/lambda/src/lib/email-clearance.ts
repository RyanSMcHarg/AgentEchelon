/**
 * AN EMAIL ABOUT A CONVERSATION GOES ONLY TO, AND A REPLY BY EMAIL IS POSTED ONLY FOR, A PERSON WHOSE
 * CURRENT CLEARANCE REACHES THE CONVERSATION (tenets P4 and D3).
 *
 * The email path carries a conversation's words out of the platform and a person's words back into it, on
 * the service's own roles rather than the person's vended session. So the person's own boundary is put in
 * front of both halves here, in the two checks every path that acts for a person makes:
 *   1. the conversation's classification, from its immutable `classification` tag, read through the
 *      container's one memo (`memoizedTagReader`, `readChannelClassificationTag`);
 *   2. the person's clearance now, through each issuer they sign in with (`Directory.clearanceOf`),
 *      compared the way membership sources and connector participants compare it
 *      (`ProfileRegistry.holderReaches`, the admin plane included when it is held).
 *
 * Membership is not the proof. A person stays a member after their clearance is lowered until the
 * membership audit acts, and the audit reports by default; this check decides on the clearance itself.
 *
 * Nothing that cannot be answered admits: a tag that cannot be read or names no classification this
 * deployment recognizes, a clearance that cannot be read, and a clearance only a sign-in token could
 * establish each refuse, and the caller sends or posts nothing for that person.
 */
import { readChannelClassificationTag, type TagReader } from './channel-classification.js';
import { memoizedTagReader } from './conversation-primary.js';
import type { Directory } from './membership-source.js';
import { personIdFromArn } from './person-arn.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';

/** Why a person is refused the email path for a conversation. Each is a counted, logged outcome. */
export type EmailClearanceRefusal = 'classification-unreadable' | 'not-cleared' | 'clearance-unresolved';

/** The conversation's classification, or undefined when its tag cannot be read or names none this deployment recognizes. */
export function conversationClassificationOf(tags: TagReader, channelArn: string, logPrefix: string): Promise<string | undefined> {
  return readChannelClassificationTag(memoizedTagReader(tags), channelArn, logPrefix);
}

/** Whether the person's current clearance reaches `classification`, through each of their issuers. */
export async function personReaches(
  directory: Pick<Directory, 'clearanceOf'>,
  personArn: string,
  classification: string,
): Promise<'cleared' | Exclude<EmailClearanceRefusal, 'classification-unreadable'>> {
  let clearance: Awaited<ReturnType<Directory['clearanceOf']>>;
  try {
    clearance = await directory.clearanceOf(personArn);
  } catch (err) {
    console.warn('[email-clearance] a person\'s clearance could not be read; refusing', {
      personId: personIdFromArn(personArn), err: (err as Error)?.name,
    });
    return 'clearance-unresolved';
  }
  if (clearance.state === 'undetermined') return 'clearance-unresolved';
  return clearance.state === 'held'
    && profiles.holderReaches({ token: clearance.token, adminPlane: clearance.adminPlane === true }, classification)
    ? 'cleared'
    : 'not-cleared';
}

/** Both checks for one person and one conversation: its classification on success, the refusal otherwise. */
export async function personClearedForConversation(args: {
  tags: TagReader;
  directory: Pick<Directory, 'clearanceOf'>;
  channelArn: string;
  personArn: string;
  logPrefix: string;
}): Promise<{ ok: true; classification: string } | { ok: false; reason: EmailClearanceRefusal }> {
  const classification = await conversationClassificationOf(args.tags, args.channelArn, args.logPrefix);
  if (!classification) return { ok: false, reason: 'classification-unreadable' };
  const answer = await personReaches(args.directory, args.personArn, classification);
  return answer === 'cleared' ? { ok: true, classification } : { ok: false, reason: answer };
}
