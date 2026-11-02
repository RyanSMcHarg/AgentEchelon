/**
 * A CONVERSATION WITHOUT WHO SAID IT (SPEC-ADMIN-CONSOLE FR54, DESIGN-ADMIN-CONSOLE 5.3).
 *
 * Turns one conversation's archived rows into its de-identified copy: one timeline of messages and
 * membership changes, each person a pseudonym stable within this conversation, personal data in what
 * was said replaced by the detector's typed placeholder. Pure apart from the detector it is handed, so
 * the rules below are tested without AWS.
 *
 * - A removed message stays in place with no text: an answer is never shown without the message it
 *   answered. Its content is never sent to the detector, so it is never in the copy at all.
 * - An edited message keeps its first version beside its current one, both de-identified.
 * - A person is `Person N` in order of first appearance; an assistant keeps its assistant name, which
 *   is not personal data and is what a team reviews. A participant's own display name or address is
 *   replaced by their pseudonym before the detector runs, so it is caught even where the detector
 *   would miss it.
 */

/** One archived row of a conversation, as the data plane reads it (`clean-copy.ts`). */
export interface SourceRow {
  kind: 'message' | 'membership';
  /** The Amazon Chime SDK MessageId, for a message. */
  messageId: string | null;
  at: string;
  /** Who sent the message, or who changed the membership. */
  actorArn: string;
  actorName: string | null;
  /** The answering assistant's id, on an assistant's message. */
  agentType: string | null;
  /** The text as first sent. */
  content: string | null;
  /** The text after an edit, or an assistant's finalized reply. */
  updatedContent: string | null;
  /** A `-RED` or `-DEL` sibling exists. */
  removed: 'redacted' | 'deleted' | null;
  /** Membership: `joined`, `left`, `granted_moderator`, `revoked_moderator`. */
  action: string | null;
  subjectArn: string | null;
  subjectName: string | null;
}

/** One row of the de-identified copy. */
export interface CleanRow {
  seq: number;
  kind: 'message' | 'membership';
  sourceMessageId: string | null;
  occurredAt: string;
  actor: string;
  actorKind: 'person' | 'assistant';
  action: string | null;
  subject: string | null;
  text: string | null;
  originalText: string | null;
  state: 'present' | 'redacted' | 'deleted';
}

/** Anonymizes many texts in one go, returning them in the same order. */
export type Anonymize = (texts: string[]) => Promise<string[]>;

const isAssistant = (arn: string): boolean => arn.includes('/bot/');

/** An Amazon Chime SDK user ARN, a person's or their administration identity's. */
const USER_ARN = /arn:aws:chime:[a-z0-9-]*:\d*:app-instance\/[A-Za-z0-9-]+\/user\/[A-Za-z0-9_-]+/g;

/**
 * THE VERSION OF THESE RULES. Recorded with every derived conversation beside the detector, and a copy
 * derived under another version is pending again, so a change to what is replaced re-derives every
 * conversation rather than only the ones that happen to change next. Raise it with any rule change.
 *
 * 2: user ARNs are replaced by rule (the detector left most of one behind).
 * 3: a bare place name is kept; only a street-level address is masked (`replacementFor`).
 * 4: an assistant is named the same in every row of a conversation.
 */
export const DEIDENTIFY_RULES_VERSION = 4;

/** Assistant display: the assistant id the turn recorded, else the bot's display name. */
function assistantName(row: { agentType?: string | null; name?: string | null }): string {
  return row.agentType || row.name || 'Assistant';
}

/** Escape a literal for a RegExp. */
const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the de-identified copy of one conversation. `anonymize` is called once, with every text that
 * needs it, so a detector that charges per request pays for the conversation once.
 */
export async function deIdentify(source: SourceRow[], anonymize: Anonymize): Promise<CleanRow[]> {
  const ordered = [...source].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Pseudonyms in order of first appearance, actor or subject alike.
  const people = new Map<string, string>();
  const knownNames = new Map<string, string>();
  const personFor = (arn: string, name: string | null): string => {
    let p = people.get(arn);
    if (!p) {
      p = `Person ${people.size + 1}`;
      people.set(arn, p);
    }
    if (name && name.trim().length >= 3) knownNames.set(name.trim(), p);
    return p;
  };
  // ONE NAME PER ASSISTANT IDENTITY. Only some of a bot's rows record which assistant answered (a
  // welcome or a membership change does not), so labelling each row from its own fields named one
  // assistant `concierge` in one row and `Concierge` in the next. Any row that names it names it for
  // every row of the same bot.
  const assistantIdByArn = new Map<string, string>();
  for (const r of ordered) if (isAssistant(r.actorArn) && r.agentType) assistantIdByArn.set(r.actorArn, r.agentType);
  const labelFor = (arn: string, name: string | null, agentType: string | null): { label: string; kind: 'person' | 'assistant' } =>
    isAssistant(arn)
      ? { label: assistantName({ agentType: assistantIdByArn.get(arn) ?? agentType, name }), kind: 'assistant' }
      : { label: personFor(arn, name), kind: 'person' };

  const labelled = ordered.map((r) => ({
    r,
    actor: labelFor(r.actorArn, r.actorName, r.agentType),
    subject: r.kind === 'membership' && r.subjectArn ? labelFor(r.subjectArn, r.subjectName, null) : null,
  }));

  // A participant's own name or address, where it appears in what was said, becomes their pseudonym,
  // bracketed like every other replacement so a reader can tell it was not typed that way. Longest
  // first, so a full name is replaced before a part of it could be.
  const names = [...knownNames.entries()].sort((a, b) => b[0].length - a[0].length);
  // A USER'S ARN IS WHO THEY ARE: it carries their sign-in id. It is replaced by rule, never left to the
  // detector, which was measured masking only the front of one and leaving most of the id behind. A
  // participant's becomes their pseudonym; anyone else's is described.
  const replaceArns = (text: string): string => text.replace(USER_ARN, (arn) => {
    const p = people.get(arn);
    return p ? `[${p}]` : '[a user id removed]';
  });
  const replaceKnown = (text: string): string =>
    names.reduce((t, [name, pseudonym]) => t.replace(new RegExp(literal(name), 'gi'), `[${pseudonym}]`), replaceArns(text));

  // Collect every text the detector must see: the current text of each present message, and the
  // first version where an edit changed it. A removed message contributes nothing.
  const texts: string[] = [];
  const positions = labelled.map(({ r, actor }) => {
    if (r.kind !== 'message' || r.removed) return null;
    const current = r.updatedContent ?? r.content ?? '';
    // An assistant's update finalizes its own placeholder, which is not an edit anyone made.
    const edited = actor.kind === 'person' && r.updatedContent != null && r.content != null && r.updatedContent !== r.content;
    const currentAt = texts.push(replaceKnown(current)) - 1;
    const originalAt = edited ? texts.push(replaceKnown(r.content ?? '')) - 1 : null;
    return { currentAt, originalAt };
  });

  const masked = texts.length ? await anonymize(texts) : [];
  if (masked.length !== texts.length) throw new Error(`detector returned ${masked.length} texts for ${texts.length}`);

  return labelled.map(({ r, actor, subject }, seq) => {
    const position = positions[seq];
    return {
      seq,
      kind: r.kind,
      sourceMessageId: r.kind === 'message' ? r.messageId : null,
      occurredAt: r.at,
      actor: actor.label,
      actorKind: actor.kind,
      action: r.kind === 'membership' ? r.action : null,
      subject: subject?.label ?? null,
      text: position ? masked[position.currentAt] : null,
      originalText: position && position.originalAt !== null ? masked[position.originalAt] : null,
      state: r.removed ?? 'present',
    };
  });
}

/** The separator a batch of texts is joined with for one detector call: no personal data in it. */
export const SEGMENT = '\n<<<AE-SEGMENT>>>\n';

/**
 * Group texts into detector calls under a character budget, call once per group, and split the answer
 * back. A group whose answer does not split into as many parts as it was given - the detector altered
 * a separator - is retried one text per call, so a text is never attributed to its neighbor.
 */
export async function inGroups(texts: string[], budget: number, call: (text: string) => Promise<string>): Promise<string[]> {
  const out: string[] = [];
  let group: string[] = [];
  let size = 0;
  const flush = async () => {
    if (!group.length) return;
    const answer = (await call(group.join(SEGMENT))).split(SEGMENT);
    if (answer.length === group.length) out.push(...answer);
    else for (const t of group) out.push(await call(t));
    group = [];
    size = 0;
  };
  for (const t of texts) {
    if (size + t.length + SEGMENT.length > budget && group.length) await flush();
    group.push(t);
    size += t.length + SEGMENT.length;
  }
  await flush();
  return out;
}
