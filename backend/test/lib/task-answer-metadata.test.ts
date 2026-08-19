/**
 * The task-answer hint a client stamps on a message (ADR-030, ADR-032).
 *
 * It is an UNTRUSTED DELIVERY HINT, read off the message stream to repair an answer that reached no
 * assistant. So the only property worth pinning here is that it degrades to "an ordinary message" on
 * anything it cannot read - never throws, never half-parses. The authority questions (may this
 * assistant answer, does it own the task) belong to the handler and are tested there.
 */
import { extractTaskAnswerHint } from '../../lambda/src/lib/task-answer-metadata';

const meta = (o: unknown) => JSON.stringify(o);

describe('extractTaskAnswerHint', () => {
  it('reads the task id', () => {
    expect(extractTaskAnswerHint(meta({ task: { id: 't-1' } }))).toEqual({ taskId: 't-1' });
  });

  it('IGNORES an assistant a client tries to name', () => {
    // The task already records `assistantId` - whose work it is, fixed for its life - so a copy here
    // would be a second source for one fact, free to disagree with the row it describes. Carrying it
    // would also be the more expensive mistake: a wrong copy dispatches a turn to the wrong assistant,
    // which then hands over and sends the person a redirection receipt. Reading the task is one point
    // read, on a path that only runs when something is already broken.
    expect(extractTaskAnswerHint(meta({ task: { id: 't-1', assistant: 'AltSlot0' } })))
      .toEqual({ taskId: 't-1' });
  });

  it('ignores metadata carrying no task', () => {
    // The common case by far: this rides the same blob as attachments and notify directives.
    expect(extractTaskAnswerHint(meta({ attachment: { fileKey: 'k', type: 'image/png' } }))).toBeUndefined();
    expect(extractTaskAnswerHint(meta({}))).toBeUndefined();
    expect(extractTaskAnswerHint(undefined)).toBeUndefined();
  });

  it('degrades rather than throwing on anything malformed', () => {
    // This is read on messages the deployment did not author. Unparseable metadata must cost the
    // repair, never the message.
    expect(extractTaskAnswerHint('not json at all')).toBeUndefined();
    expect(extractTaskAnswerHint('null')).toBeUndefined();
    expect(extractTaskAnswerHint(meta({ task: 'a string' }))).toBeUndefined();
    expect(extractTaskAnswerHint(meta({ task: { id: 42 } }))).toBeUndefined();
    expect(extractTaskAnswerHint(meta({ task: { id: '' } }))).toBeUndefined();
  });

  it('carries the id and nothing else, whatever else is sent', () => {
    // Extra keys are dropped rather than passed through, so a client cannot introduce a second copy of
    // a fact the task already holds simply by sending one.
    expect(extractTaskAnswerHint(meta({ task: { id: 't-1', assistant: 7, owner: 'x', hop: 2 } })))
      .toEqual({ taskId: 't-1' });
  });
});
