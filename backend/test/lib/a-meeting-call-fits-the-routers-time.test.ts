/**
 * A MEETING CALL FITS THE ROUTER'S OWN TIME, AND ONE THAT WAS NOT ANSWERED IS DECIDED FROM THE RECORD (`meeting-run.ts`).
 *
 *  - every synchronous call to a meetings entry is made once: an entry that ran past its bound may have acted (a start is
 *    not idempotent), and a second attempt would outlast the router's 30 seconds;
 *  - a meeting's summary writes its transcript and reads its figures at once, so the two entries' bounds do not add up;
 *  - a workflow's start that was not answered announces the meeting the records say it started, with what is left of
 *    its ring, rather than leaving a meeting running unannounced.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const router = fs.readFileSync(path.join(SRC, 'router-agent-handler.ts'), 'utf8');
const fnOf = (name: string): string => {
  const start = router.search(new RegExp(`\\n(export )?(async )?function ${name}[(<]`));
  expect(start).toBeGreaterThan(-1);
  const next = router.slice(start + 10).search(/\n(export )?(async )?function /);
  return router.slice(start, next < 0 ? undefined : start + 10 + next);
};

describe('a meetings entry is called once', () => {
  it('its client makes one attempt', () => {
    const run = fs.readFileSync(path.join(SRC, 'lib', 'meeting-run.ts'), 'utf8');
    const client = run.slice(run.indexOf('function boundedClient('), run.indexOf('type Ok<T>'));
    expect(client).toContain('maxAttempts: 1,');
  });
});

describe("a meeting's summary", () => {
  it('writes the transcript and reads the figures at once', () => {
    const fn = fnOf('handleMeetingSummaryFired');
    expect(fn).toMatch(/const \[t, s\] = await Promise\.all\(\[\s*runFn && last\.transcription\?\.everOn \? transcribeEndedMeeting\(/);
  });
});

describe("a workflow's start that was not answered", () => {
  it('is decided from the records: the meeting this assistant started here is announced, with what is left of its ring', () => {
    const fn = fnOf('startMeetingStep');
    expect(fn).toContain("if (!reached || (!started.ok && started.code === 'ENTRY_FAILED')) {");
    expect(fn).toContain('recovered = await meetingThisStepStarted(args.channelArn, botIdFromArn(args.botArn) ?? \'\');');
    expect(fn).toContain('const ring = recovered ? ringLeft(recovered.meeting) : ringOnStart(started.created, started.ringSeconds);');
    const found = fnOf('meetingThisStepStarted');
    expect(found).toContain("a.startedVia !== 'workflow' || a.createdBy !== botId");
  });
});
