/**
 * A LINK TO ONE MESSAGE IN A CONVERSATION.
 *
 * The console's conversation viewer opens at a conversation (`?conv=<channelId>`), and with these parameters
 * at a message inside it:
 *
 * - `msg`: the message's Amazon Chime SDK MessageId, the id the viewer's read returns for each message;
 * - `at`: an ISO time, the moment the linked message was sent. When the message is not in the record the
 *   viewer reads, the viewer opens at the message nearest this time and says so;
 * - `kind`: what the linked message is, from a closed set, so the viewer's note can name it ("the battle's
 *   starting message") rather than speak of "the linked message". An unknown value is ignored.
 *
 * Any surface that knows a conversation and a message can link to it this way: it hands the viewer a
 * `MessageLink`, and the dashboard writes it into the URL so the link can be shared.
 */

/** What a linked message is. Each one names the message in the viewer's note when it cannot be shown. */
export type MessageLinkKind = 'battle';
const KINDS: readonly MessageLinkKind[] = ['battle'];

export interface MessageLink {
  /** The Amazon Chime SDK MessageId. */
  messageId: string | null;
  /** When the message was sent (ISO), the place to open when the message itself is not in the record. */
  at: string | null;
  kind?: MessageLinkKind | null;
}

const PARAM = { messageId: 'msg', at: 'at', kind: 'kind' } as const;

const kindOf = (v: string | null): MessageLinkKind | null =>
  v && (KINDS as readonly string[]).includes(v) ? (v as MessageLinkKind) : null;

/** The message a URL's query string links to, or null when it names neither a message nor a time. */
export function messageLinkFromSearch(search: string): MessageLink | null {
  const p = new URLSearchParams(search);
  const messageId = p.get(PARAM.messageId) || null;
  const atRaw = p.get(PARAM.at);
  const at = atRaw && !Number.isNaN(Date.parse(atRaw)) ? atRaw : null;
  if (!messageId && !at) return null;
  return { messageId, at, kind: kindOf(p.get(PARAM.kind)) };
}

/** Writes the link into a URL's query string, or removes it when `link` is null. Returns whether anything changed. */
export function writeMessageLink(url: URL, link: MessageLink | null): boolean {
  const want: Record<string, string | null> = {
    [PARAM.messageId]: link?.messageId || null,
    [PARAM.at]: link?.at || null,
    [PARAM.kind]: link?.kind || null,
  };
  let changed = false;
  for (const [key, value] of Object.entries(want)) {
    if (url.searchParams.get(key) === value) continue;
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    changed = true;
  }
  return changed;
}

/** The row sent nearest `at`, or null when there is no row or no readable time. */
export function nearestTo<T extends { timestamp?: unknown }>(rows: T[], at: string | null): T | null {
  const target = at ? Date.parse(at) : NaN;
  if (Number.isNaN(target)) return null;
  let best: T | null = null;
  let bestGap = Infinity;
  for (const r of rows) {
    const t = Date.parse(String(r.timestamp ?? ''));
    if (Number.isNaN(t)) continue;
    const gap = Math.abs(t - target);
    if (gap < bestGap) { best = r; bestGap = gap; }
  }
  return best;
}
