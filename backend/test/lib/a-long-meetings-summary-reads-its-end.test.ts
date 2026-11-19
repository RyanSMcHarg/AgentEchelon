/**
 * A LONG MEETING'S SUMMARY READS ITS END, AND WHAT IT WRITES ALWAYS ENCODES (SPEC-ASSISTANT-MEETINGS FR66).
 *
 *  - the segments read are the last spoken, since a meeting's decisions and action items come at its end;
 *  - one result the service shares between two speakers is a line for each, in the transcript's own order;
 *  - a transcript that cannot be read is tried again, and is never taken for a meeting that kept no transcript;
 *  - nothing the platform cuts splits a surrogate pair, so the card's encoded length can always be measured;
 *  - a list on the card is listed whole lines at a time, within its template value's cap.
 */
import {
  clip, fitSummaryCard, meetingSummaryPrompt, participantLegend, readMeetingSegments, readMeetingSummaryReply, runMeetingSummaryTurn,
  wholeLinesWithin, type MeetingSummaryDeps,
} from '../../lambda/src/lib/meeting-summary-turn';
import type { TranscriptSegment } from '../../lambda/src/lib/meeting-transcript';

const seg = (personId: string, startMs: number, text: string, resultId = `r${startMs}`): TranscriptSegment => ({ resultId, personId, startMs, endMs: startMs + 500, text });

describe('the segments read', () => {
  it('are the last spoken where the meeting has more than are read', async () => {
    const total = 3500;
    const keys = Array.from({ length: total }, (_, i) => `transcripts/premium/c/m/segments/${String(i).padStart(13, '0')}-p-r${i}.json`);
    const s3 = {
      send: async (c: unknown) => {
        const cmd = c as { __t: string; input: Record<string, unknown> };
        if (cmd.__t === 'list') {
          const from = Number(cmd.input.ContinuationToken ?? 0);
          const page = keys.slice(from, from + 1000);
          return { Contents: page.map((Key) => ({ Key })), IsTruncated: from + 1000 < total, NextContinuationToken: String(from + 1000) };
        }
        const i = Number(/r(\d+)\.json$/.exec(String(cmd.input.Key))![1]);
        return { Body: { transformToString: async () => JSON.stringify(seg('p', i, `line ${i}`, `r${i}`)) } };
      },
    };
    const out = await readMeetingSegments(s3, 'b', { classification: 'premium', conversationId: 'c', meetingId: 'm' }, {
      list: (input) => ({ __t: 'list', input }), get: (input) => ({ __t: 'get', input }),
    });
    expect(out).toHaveLength(3000);
    expect(out[0].startMs).toBe(500);
    expect(out[out.length - 1].startMs).toBe(total - 1);
  });
});

describe('the prompt', () => {
  it('keeps a result heard from two speakers as a line for each, and a repeat from one speaker once', () => {
    const segments = [seg('u-a', 1000, 'hello', 'r1'), seg('u-b', 1000, 'hello', 'r1'), seg('u-a', 1000, 'hello', 'r1')];
    const legend = participantLegend([], segments);
    const prompt = meetingSummaryPrompt(legend, segments, {});
    expect(prompt.match(/\] P\d: hello/g)).toHaveLength(2);
  });
});

describe('a transcript that cannot be read', () => {
  const deps = (segments: MeetingSummaryDeps['segments']) => {
    const outcomes: string[] = [];
    const d: MeetingSummaryDeps = {
      meter: async () => true, segments, invoke: async () => ({ response: '{"summary":"s"}' }), measure: async () => undefined,
      handBack: async () => true, record: (o) => { outcomes.push(o); }, pause: async () => undefined,
    };
    return { d, outcomes };
  };
  const REQ = { meetingArn: 'arn:a/channel/m', meetingId: 'm', attendees: [], card: { messageId: 'x', room: 'arn:a/channel/r' } };

  it('is read again, and a read that comes back writes the summary', async () => {
    let calls = 0;
    const { d } = deps(async () => { calls += 1; if (calls < 2) throw new Error('SlowDown'); return [seg('u-a', 0, 'hi')]; });
    expect(await runMeetingSummaryTurn(REQ, d)).toBe('written');
    expect(calls).toBe(2);
  });

  it('is recorded as unreadable after its tries, never as a meeting that kept no transcript', async () => {
    const segments = jest.fn(async () => { throw Object.assign(new Error('x'), { name: 'InternalError' }); });
    const { d } = deps(segments);
    expect(await runMeetingSummaryTurn(REQ, d)).toBe('fallback:transcript-unreadable');
    expect(segments).toHaveBeenCalledTimes(3);
    expect(await runMeetingSummaryTurn(REQ, deps(async () => []).d)).toBe('fallback:no-transcript');
  });
});

describe('a cut never splits a character', () => {
  const emoji = '\u{1F600}';
  it('leaves out the half of a pair at either end', () => {
    expect(clip(`ab${emoji}`, 3)).toBe('ab');
    expect(clip(`${emoji}ab`, -3)).toBe('ab');
    expect(clip('abc', 5)).toBe('abc');
    expect(() => encodeURIComponent(clip(`a${emoji}`.repeat(10), 7))).not.toThrow();
  });

  it('reads a model reply cut at its cap, and fits a card whose summary is shortened, without an encoding error', async () => {
    const legend = participantLegend([], [seg('u-a', 0, 'x')]);
    const long = `${'a'.repeat(1499)}${emoji}`;
    const c = readMeetingSummaryReply(JSON.stringify({ summary: long }), legend)!;
    expect(() => encodeURIComponent(c.summary)).not.toThrow();
    const render = (p: { summary: string }) => p.summary;
    const fitted = await fitSummaryCard(render, { summary: emoji.repeat(400), keyPoints: [], itemLines: [] }, 600);
    expect(fitted).toBeDefined();
    expect(() => encodeURIComponent(fitted!.summary)).not.toThrow();
  });
});

describe('a list on the card', () => {
  it('is listed whole lines at a time within its value\'s cap', () => {
    expect(wholeLinesWithin(['aaaa', 'bbbb', 'cccc'], 9)).toEqual(['aaaa', 'bbbb']);
    expect(wholeLinesWithin(['aaaa', 'bbbb'], 8, '- ')).toEqual(['aaaa']);
  });

  it('never ends in the middle of an item', async () => {
    const items = Array.from({ length: 12 }, (_, i) => `- item ${i} ${'x'.repeat(200)}`);
    const fitted = (await fitSummaryCard((p) => p.itemLines.join('\n'), { summary: 's', keyPoints: [], itemLines: items }, 100_000, 2000))!;
    expect(fitted.itemLines.join('\n').length).toBeLessThanOrEqual(2000);
    expect(items.slice(0, fitted.itemLines.length)).toEqual(fitted.itemLines);
  });
});
