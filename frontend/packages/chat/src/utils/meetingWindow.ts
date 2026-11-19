/**
 * THE MEETING WINDOW: a conversation's meeting full-window, with the conversation's chat beside it, at
 * `<app>?meeting=<conversation id>`.
 *
 * It is the window an email's join button, a ring's answer, a meeting link in a message and the conversation's meeting
 * control all open. The person signs in there like anywhere in the app, and joining checks they are a member of the
 * conversation, so the link opens nothing for anyone else.
 *
 * The request is read from the URL once, at load, and kept for the tab's session until the window shows it, so a
 * sign-in that leaves the page and comes back (a federated issuer's redirect) still lands in the meeting.
 */

const QUERY = 'meeting';
const KEPT = 'ae.meeting.window';
/** A conversation id as the app names one. */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The meeting window's address for a conversation, relative to the app. */
export function meetingWindowHref(conversationId: string): string {
  return `?${QUERY}=${encodeURIComponent(conversationId)}`;
}

/** A conversation id or channel ARN as the id the window names. */
export function conversationIdOf(conversation: string): string {
  return conversation.split('/').pop() || conversation;
}

/** The window name a meeting's window goes by: the meeting's own conversation where it is known. */
export function meetingWindowName(conversation: string): string {
  return `ae-meeting-${conversationIdOf(conversation)}`;
}

/**
 * The window shows a meeting: it takes that meeting's name, so whichever way the person entered (the room's control, a
 * ring, a card's link, an email's button) every later open of the same meeting finds this window.
 */
export function nameMeetingWindow(meetingConversation: string): void {
  try { window.name = meetingWindowName(meetingConversation); } catch { /* the window keeps the name it opened with */ }
}

/** Where this browser keeps which window shows a conversation's meeting, by the conversation's id. */
const ALIASES = 'ae.meeting.windowFor';

function readAliases(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ALIASES) || '{}') as unknown;
    return raw && typeof raw === 'object' ? raw as Record<string, string> : {};
  } catch {
    return {};
  }
}

/**
 * THIS WINDOW IS IN THE MEETING OF THESE CONVERSATIONS (its room among them): recorded in this browser while it is, so an
 * open for any of them (a ring for the room, a card's link) finds this window rather than opening a second one for the
 * same meeting. `unaliasMeetingWindow` takes the record back when the window leaves the meeting.
 */
export function aliasMeetingWindow(conversationIds: readonly string[]): void {
  let name = '';
  try { name = window.name; } catch { return; }
  if (!name.startsWith('ae-meeting-')) return;
  const aliases = readAliases();
  for (const id of conversationIds.map(conversationIdOf)) if (id && CONVERSATION_ID.test(id)) aliases[id] = name;
  try { localStorage.setItem(ALIASES, JSON.stringify(aliases)); } catch { /* each open finds the window by its own name */ }
}

/** This window is in no meeting now: no conversation's open finds it by what was recorded. */
export function unaliasMeetingWindow(): void {
  let name = '';
  try { name = window.name; } catch { return; }
  if (!name) return;
  const aliases = readAliases();
  let changed = false;
  for (const [id, n] of Object.entries(aliases)) if (n === name) { delete aliases[id]; changed = true; }
  if (!changed) return;
  try { localStorage.setItem(ALIASES, JSON.stringify(aliases)); } catch { /* the record stays until overwritten */ }
}

/** The window name a meeting window for a conversation goes by: the meeting's own where known, else what this browser recorded. */
function windowNameFor(conversation: string, meetingConversation?: string): string {
  if (meetingConversation) return meetingWindowName(meetingConversation);
  const alias = readAliases()[conversationIdOf(conversation)];
  return typeof alias === 'string' && /^ae-meeting-[A-Za-z0-9_-]{1,128}$/.test(alias) ? alias : meetingWindowName(conversation);
}

/** Whether a window has loaded a page, rather than being the blank window an open by name just created. */
function hasLoaded(w: Window): boolean {
  try {
    return w.location.href !== 'about:blank';
  } catch {
    // A page of another origin answers nothing about itself; it is not this meeting's window.
    return false;
  }
}

/**
 * Open a conversation's meeting window beside the app, ONE PER MEETING: the window is looked up by the meeting's own
 * conversation (`meetingConversation`) where the caller knows it, else by the conversation, and a window already open
 * under that name is brought forward as it is, never reloaded, so a person in the meeting stays in it.
 */
export function openMeetingWindow(conversation: string, meetingConversation?: string): void {
  const href = meetingWindowHref(conversationIdOf(conversation));
  // Opened by name with no address: the browser answers the existing window of that name untouched, or a new blank one,
  // which is then sent to the meeting.
  const opened = window.open('', windowNameFor(conversation, meetingConversation), 'popup,width=1280,height=800');
  // A browser that refuses a pop-up opens the window in this tab instead.
  if (!opened) { window.location.assign(href); return; }
  if (hasLoaded(opened)) { opened.focus(); return; }
  opened.location.href = href;
}

/**
 * BRING FORWARD THE WINDOW A PERSON IS ALREADY IN THE MEETING FROM, and never open a second one: answers true when this
 * browser found that window by its name and raised it. A window this app tab cannot reach by name (a tab the person
 * opened themselves) is not found, and the blank window the lookup made is closed again, so nobody joins twice.
 */
export function bringMeetingWindowForward(conversation: string, meetingConversation?: string): boolean {
  let opened: Window | null = null;
  try { opened = window.open('', windowNameFor(conversation, meetingConversation), 'popup,width=1280,height=800'); } catch { opened = null; }
  if (!opened) return false;
  if (hasLoaded(opened)) { opened.focus(); return true; }
  try { opened.close(); } catch { /* a blank window the person may close */ }
  return false;
}

/** A percent-encoded value decoded, or null for one that does not decode. */
function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * The conversation an href names when it is this app's own meeting link (`?meeting=<conversation id>`), else null. Any
 * other href, including one whose encoding does not decode, is not a meeting link.
 */
export function meetingLinkConversation(href: string | undefined): string | null {
  if (!href) return null;
  const match = /^\?meeting=([^/\\&#]*)$/.exec(href);
  const id = match ? decoded(match[1]) : null;
  return id !== null && CONVERSATION_ID.test(id) ? id : null;
}

/** Whether an href is this app's own meeting link, the one shape a message's link opens as the meeting window. */
export function isMeetingWindowLink(href: string | undefined): boolean {
  return meetingLinkConversation(href) !== null;
}

/**
 * The conversation this window shows the meeting of, or null: from `?meeting=` on first load (kept for the session), or
 * from what an earlier load kept. Every read answers the same until the window is closed.
 */
export function meetingWindowRequest(search: string = window.location.search): string | null {
  const fromUrl = new URLSearchParams(search).get(QUERY);
  if (fromUrl && CONVERSATION_ID.test(fromUrl)) {
    try { sessionStorage.setItem(KEPT, fromUrl); } catch { /* the URL still carries it this load */ }
    return fromUrl;
  }
  try {
    const kept = sessionStorage.getItem(KEPT);
    return kept && CONVERSATION_ID.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

/** The window no longer shows a meeting: what was kept is cleared, and the app shows its conversations. */
export function closeMeetingWindow(): void {
  try { sessionStorage.removeItem(KEPT); } catch { /* nothing was kept */ }
  // The window gives up its meeting's name, so a window that becomes the app is never found as that meeting's window.
  unaliasMeetingWindow();
  try { window.name = ''; } catch { /* a closed window is found by no name */ }
  window.close();
  // A window the app did not open cannot close itself; it becomes the app again.
  window.location.assign(window.location.pathname);
}
