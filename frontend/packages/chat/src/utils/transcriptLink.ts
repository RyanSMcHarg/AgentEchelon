/**
 * A MEETING TRANSCRIPT'S LINK (`?transcript=<key>`), as the platform's ended card carries it (SPEC-ASSISTANT-MEETINGS FR28):
 * the key of the transcript in its meeting conversation's transcript family, `transcripts/<classification>/<conversationId>/
 * <meetingId>.md` (`backend/lambda/src/lib/meeting-transcript.ts`). The shape test is all this decides: following the link
 * asks the attachment download path, which signs it only for a member of that conversation cleared for its classification.
 *
 * A MEETING RECORDING'S LINK (`?recording=<key>`, SPEC-ASSISTANT-MEETINGS FR70) is opened the same way: the composited audio
 * and video file in its meeting conversation's recording family, `recordings/<classification>/<conversationId>/<meetingId>/
 * <part>/media/composited-video/<id>.mp4` (`backend/lambda/src/lib/meeting-recording.ts`), which the browser plays in its tab.
 */

const TRANSCRIPT_KEY = /^transcripts\/[a-z0-9-]{1,64}\/([A-Za-z0-9_-]{1,128})\/[A-Za-z0-9-]{1,64}\.md$/;
const RECORDING_KEY = /^recordings\/[a-z0-9-]{1,64}\/([A-Za-z0-9_-]{1,128})\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9-]{1,64}\/media\/composited-video\/[A-Za-z0-9-]{1,64}\.mp4$/;

/** The transcript or recording a link names, with the conversation it belongs to; null for any other href. */
export function transcriptLinkTarget(href: string | undefined): { key: string; conversationId: string } | null {
  const match = /^\?(transcript|recording)=([^&#]*)$/.exec(href ?? '');
  if (!match) return null;
  let key: string;
  try { key = decodeURIComponent(match[2]); } catch { return null; }
  const parts = (match[1] === 'transcript' ? TRANSCRIPT_KEY : RECORDING_KEY).exec(key);
  return parts ? { key, conversationId: parts[1] } : null;
}

/**
 * Open the transcript in a new tab through a signed address. Resolves false where it could not be signed, or where the
 * browser would not open a tab.
 *
 * THE TAB OPENS INSIDE THE CLICK, before the address is signed: a browser lets a page open a tab only while the click is
 * fresh, and signing may take longer than that, so the tab is opened blank at once, cut off from this one, and sent to the
 * signed address once it arrives. A tab the browser refused is said in place rather than lost silently.
 */
export async function openTranscript(target: { key: string; conversationId: string }, opts: { download?: boolean } = {}): Promise<boolean> {
  const tab = window.open('about:blank', '_blank');
  if (!tab) return false;
  try { tab.opener = null; } catch { /* the tab holds no handle on this one either way */ }
  try {
    // Loaded when a transcript is opened, so every message renderer does not load the attachment service.
    const { getDownloadUrl } = await import('../services/attachmentService');
    // A DOWNLOAD is signed to save under the platform's name for the file (`disposition: attachment`); a view shows it.
    tab.location.href = await getDownloadUrl(target.key, target.conversationId, '', opts.download ? { disposition: 'attachment' } : {});
    return true;
  } catch {
    tab.close();
    return false;
  }
}
