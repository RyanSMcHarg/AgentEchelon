/**
 * WHICH ASSISTANT A `/stop` WAS AIMED AT (ADR-033).
 *
 * A room can hold several assistants, each with its own queue and its own turn in flight. "Stop"
 * aimed at the one writing a report must not also stop the one halfway through an unrelated lookup,
 * because the person who sent it was watching one of them. That makes the target part of the stop's
 * identity rather than a detail, which is why the marker in `turn-lock.ts` is keyed by it.
 *
 * ── THIS IS A LOOKUP, NOT A JUDGEMENT, AND THAT IS WHY IT LIVES ON THE FAST PATH ─────────────────
 *
 * The deterministic half of a stop must never wait on a model call (DESIGN section 1.2): a person who
 * says stop has removed the ambiguity themselves, and making them wait to have it honored is the
 * design failing at the one moment it is most visible. Resolving the target reads the message and, at
 * most, the room's membership. Nothing here decides WHY the stop was sent or what becomes of the held
 * work; those are judged and happen after.
 *
 * ── THE THREE CASES, AND THE THIRD IS ASKED ABOUT RATHER THAN GUESSED ────────────────────────────
 *
 * An addressed stop names its assistant. An unaddressed stop in a room with exactly one assistant
 * means that one. An unaddressed stop in a room with several is genuinely ambiguous, and guessing is
 * the failure this module exists to prevent: picking one silences work the person may have been
 * watching, and picking all of them destroys work nobody asked to lose. So it asks.
 *
 * ── WHY THE PARSE STRIPS MENTIONS RATHER THAN MATCHING THE WHOLE MESSAGE ─────────────────────────
 *
 * The previous check was `message === '/stop'`, an exact match. In a room with several assistants
 * Amazon Chime SDK puts the bots in MENTIONS mode, so the ONLY way to reach one is to mention it, and
 * `@analyst /stop` failed that exact match. The escape hatch was therefore unreachable in precisely
 * the rooms where naming a target matters. Stripping mentions and comparing the remainder fixes that
 * without needing to know any assistant's display name, which no caller here can resolve cheaply.
 *
 * Both mention grammars are set aside: the bare `@Name` below, and the delimited `@<Name|id>` the composer's picker
 * writes (`delimitedMentionTokens`, the one reader of that grammar), so `@<Admin Assistant|id> /stop` is an
 * addressed stop like `@Advisor /stop`.
 */
import { delimitedMentionTokens } from './flow-bypass.js';

/**
 * A mention token. Deliberately narrow: letters, digits, dot, dash, underscore. Over-matching would
 * eat part of the command itself, and `\b`-style greed is what let `@allison` read as `@all` in
 * `flow-bypass.ts`, which is the same class of mistake read from the other end.
 */
const MENTION = /@[\w.-]+/g;

export interface ParsedStop {
  /** True when this message is the stop command, whatever it was addressed to. */
  isStop: boolean;
  /**
   * True when the message named an assistant. `@all` does not count: it addresses everyone, which is
   * the opposite of naming one, and treating it as addressed would turn "stop everybody" into a
   * silent single-target stop.
   */
  addressed: boolean;
}

/** Is this message `/stop`, once any mentions around it are set aside? */
export function parseStopCommand(raw: string | undefined | null): ParsedStop {
  const text = (raw || '').trim();
  if (!text) return { isStop: false, addressed: false };

  // The delimited tokens first, blanked to spaces, so the bare pattern never reads a fragment of one.
  const { tokens: delimited, blanked } = delimitedMentionTokens(text);
  const mentions = [...delimited.map((t) => `@${t.name}`), ...(blanked.match(MENTION) || [])];
  const remainder = blanked.replace(MENTION, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

  // THE REMAINDER MUST BE THE COMMAND AND NOTHING ELSE. "stop the report and summarise it instead" is
  // a redirect, not the escape hatch, and it belongs on the judged path where its intent is read.
  if (remainder !== '/stop') return { isStop: false, addressed: false };

  const named = mentions.filter((m) => !/^@all$/i.test(m));
  return { isStop: true, addressed: named.length > 0 };
}

export type StopTarget =
  | { kind: 'target'; responderId: string }
  | { kind: 'ambiguous'; assistantCount: number };

/**
 * Who this stop reaches.
 *
 * `thisResponderId` is the assistant whose router is running. That is not an assumption: Amazon Chime
 * SDK delivered the message here, so in an addressed stop this IS the assistant that was named, and
 * in a one-assistant room it is the only one there is.
 */
export function resolveStopTarget(args: {
  addressed: boolean;
  /** Assistants in the room, including this one. Zero or one both mean "no ambiguity to resolve". */
  assistantCount: number;
  thisResponderId: string;
}): StopTarget {
  const { addressed, assistantCount, thisResponderId } = args;

  // ADDRESSED WINS OUTRIGHT. The person named an assistant and Chime routed the message to it, so
  // there is nothing left to infer, whatever else is in the room.
  if (addressed) return { kind: 'target', responderId: thisResponderId };

  // A ROOM WITH ONE ASSISTANT HAS NO AMBIGUITY. An unread or unreadable count arrives here as 0 and
  // takes this branch deliberately: failing toward "stop the assistant you were talking to" keeps the
  // escape hatch working when membership cannot be read, and the cost of being wrong is bounded by
  // the marker being per-responder anyway.
  if (assistantCount <= 1) return { kind: 'target', responderId: thisResponderId };

  return { kind: 'ambiguous', assistantCount };
}

/**
 * WHERE THE COUNT COMES FROM. The router already reads channel membership live and caches it for the
 * Lambda's warm life (`getMemberArns`), so the assistant count is a filter over a response it has
 * rather than a second Chime call on the escape hatch's own path. Counting is by ARN shape: an
 * app-instance bot's ARN carries `/bot/`, the same discriminator the IAM grants pin. A recorded
 * roster copy cannot serve this, and `channel-size.ts` records why an archived membership copy
 * collapses bots.
 *
 * An unreadable membership arrives here as 0, which `resolveStopTarget` reads as "no ambiguity": the
 * escape hatch must not become a question the person has to answer before anything stops.
 */

