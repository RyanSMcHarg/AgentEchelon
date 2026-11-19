/**
 * A phone leg's lifecycle, apart from the servers so it can be checked on its own.
 *
 * A leg can end at any moment: the caller hangs up, Twilio refuses the dial-out, or someone presses Hang up. Joining
 * takes several steps, so after each one the join checks the leg is still wanted and gives back what it made when it
 * is not. No ended leg keeps an attendee in the meeting or a page open.
 */

/**
 * Joins a leg's attendee and opens its page. Returns false, having removed anything it made, when the leg ended meanwhile.
 * `deps.createAttendee()` and `deps.openPage()` make the two; `deps.deleteAttendee(attendee)` and `deps.closePage(page)`
 * give them back.
 */
export async function joinLegResources(leg, deps) {
  const attendee = await deps.createAttendee();
  if (leg.status === 'ended') {
    await deps.deleteAttendee(attendee).catch(() => {});
    return false;
  }
  leg.attendee = attendee;
  const page = await deps.openPage();
  if (leg.status === 'ended') {
    await deps.closePage(page).catch(() => {});
    if (leg.attendee) await deps.deleteAttendee(leg.attendee).catch(() => {});
    leg.attendee = null;
    return false;
  }
  leg.page = page;
  return true;
}

/**
 * Ends a call whose audio stream never opened: an inbound caller who hangs up during the greeting opens no stream, and
 * Twilio reports the hang-up only to a status callback. `end(why)` is called once `ms` passes with no stream on a live leg.
 * A leg whose stream opened, or that ended another way, is left as it is. Returns the timer.
 */
export function endIfNoStream(leg, ms, end) {
  const timer = setTimeout(() => {
    if (!leg.twilioWs && leg.status !== 'ended') end('the call opened no audio stream');
  }, ms);
  timer.unref?.();
  return timer;
}

/**
 * Reads one media-stream frame. Returns the frame when it is a JSON object, and null for anything else (bad JSON, a
 * bare `null`, a number, an array), so a frame from an unauthenticated socket can never reach the handler's property reads.
 */
export function parseTwilioFrame(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  return msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
}

/**
 * Places a leg's outbound call. `create()` asks Twilio for the call and resolves with it; `hangUp(sid)` completes it.
 * A leg that ended while Twilio was placing the call has that call completed at once, so no call rings with no leg
 * behind it. Returns the call when the leg is still wanted, and null when it was hung up.
 */
export async function placeCallForLeg(leg, create, hangUp) {
  const call = await create();
  leg.callSid = call.sid;
  if (leg.status === 'ended') {
    await hangUp(call.sid).catch(() => {});
    return null;
  }
  return call;
}

/**
 * Records the caller audio the leg's player has dropped so far (`pstn-player`, a running total in ms) on the leg's timings,
 * which the control page shows. Only a finite, non-negative total larger than the one recorded is taken. Returns whether
 * the timings changed.
 */
export function recordDroppedAudio(leg, droppedMs) {
  if (typeof droppedMs !== 'number' || !Number.isFinite(droppedMs) || droppedMs < 0) return false;
  const total = Math.round(droppedMs);
  if (total <= (leg.timings.droppedMs ?? 0)) return false;
  leg.timings.droppedMs = total;
  return true;
}
