/**
 * A STOP NAMES ITS ASSISTANT, AND AN AMBIGUOUS ONE IS ASKED ABOUT (ADR-033).
 *
 * Two rules that can each be silently wrong.
 *
 * THE PARSE. The check this replaces was `message === '/stop'`, exact. In a room with several
 * assistants Amazon Chime SDK puts them in MENTIONS mode, so the only way to reach one is to mention
 * it, and `@analyst /stop` failed that match: the escape hatch was unreachable in exactly the rooms
 * where naming a target is the point. It must now tolerate a mention without becoming loose enough to
 * fire on a sentence that merely contains the word.
 *
 * THE RESOLUTION. Guessing a target in a room with several assistants is the failure this exists to
 * prevent, in both directions: picking one silences work the person may have been watching, and
 * picking all of them destroys work nobody asked to lose. So it asks. But it must NOT ask when there
 * is nothing to ask about, because a stop that answers with a question has not stopped anything.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseStopCommand, resolveStopTarget } = require('../../lambda/src/lib/stop-target');

describe('recognising the stop command', () => {
  it('recognises the bare command', () => {
    expect(parseStopCommand('/stop')).toEqual({ isStop: true, addressed: false });
  });

  it('recognises it with surrounding whitespace and any casing', () => {
    expect(parseStopCommand('  /STOP  ')).toEqual({ isStop: true, addressed: false });
  });

  it('recognises it when an assistant is mentioned before it', () => {
    // The case the exact match failed, and the only way to reach one assistant in a MENTIONS-mode
    // room. Without this the escape hatch does not exist where targeting matters.
    expect(parseStopCommand('@analyst /stop')).toEqual({ isStop: true, addressed: true });
  });

  it('recognises it when the mention trails the command', () => {
    expect(parseStopCommand('/stop @analyst')).toEqual({ isStop: true, addressed: true });
  });

  it('does NOT read `@all` as naming one assistant', () => {
    // `@all` addresses everyone, which is the opposite of naming one. Treating it as addressed would
    // turn "stop everybody" into a silent single-target stop, which is the more expensive mistake.
    expect(parseStopCommand('@all /stop')).toEqual({ isStop: true, addressed: false });
  });

  it('does not fire on a sentence that merely asks for a stop', () => {
    // A redirect is not the escape hatch. It belongs on the judged path where its intent is read,
    // and firing here would discard work on the strength of a phrase (tenet D11).
    expect(parseStopCommand('stop the report and summarise it instead').isStop).toBe(false);
    expect(parseStopCommand('please /stop the report').isStop).toBe(false);
  });

  it('does not fire on a longer token that merely starts with it', () => {
    expect(parseStopCommand('/stopwatch').isStop).toBe(false);
  });

  it('is safe on empty and missing input', () => {
    expect(parseStopCommand('').isStop).toBe(false);
    expect(parseStopCommand(undefined).isStop).toBe(false);
    expect(parseStopCommand(null).isStop).toBe(false);
  });
});

describe('which assistant the stop reaches', () => {
  const THIS_BOT = 'analyst';

  it('takes the assistant that was named', () => {
    // Chime routed the message here because it was mentioned, so there is nothing left to infer even
    // in a crowded room.
    expect(resolveStopTarget({ addressed: true, assistantCount: 4, thisResponderId: THIS_BOT }))
      .toEqual({ kind: 'target', responderId: THIS_BOT });
  });

  it('takes the only assistant in a one-to-one room without asking', () => {
    expect(resolveStopTarget({ addressed: false, assistantCount: 1, thisResponderId: THIS_BOT }))
      .toEqual({ kind: 'target', responderId: THIS_BOT });
  });

  it('ASKS when the stop named nobody and the room holds several assistants', () => {
    // The rule. Nothing is stopped on this branch: the person is one word away from an unambiguous
    // stop, and a guess is not recoverable by them.
    expect(resolveStopTarget({ addressed: false, assistantCount: 3, thisResponderId: THIS_BOT }))
      .toEqual({ kind: 'ambiguous', assistantCount: 3 });
  });

  it('stops rather than asks when the room could not be read', () => {
    // An unreadable membership arrives as 0. Failing the other way would turn the escape hatch into a
    // question the person must answer before anything stops, and a stop that does not stop is the
    // worse failure of the two.
    expect(resolveStopTarget({ addressed: false, assistantCount: 0, thisResponderId: THIS_BOT }))
      .toEqual({ kind: 'target', responderId: THIS_BOT });
  });
});
