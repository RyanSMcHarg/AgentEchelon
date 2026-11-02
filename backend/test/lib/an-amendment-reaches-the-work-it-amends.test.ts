/**
 * AN AMENDMENT THAT CHANGES NOTHING IS A MESSAGE THE PERSON SENT AND NOBODY ACTED ON.
 *
 * ADR-033's per-entry table says a message arriving mid-step is "queued, as CONTEXT for the running
 * step", and DESIGN 2.4 that an `amends` reading "changes what is already running rather than opening
 * new work". Both were half-built. The reading classified the message and correctly declined to give
 * it a task - "one task per new request, and none for an amendment" - and then nothing carried it to
 * the work it amends.
 *
 * The result was silent and complete: "actually, make it one page" was read, classified, described
 * back to the person in the proposal, and the fifteen-paragraph report was delivered unchanged. Every
 * test passed, because each half did its own job.
 *
 * So these tests are about the HOP between the halves - the same reason
 * `the-triage-payload-crosses-the-boundary` exists.
 */
const send = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = (...a: unknown[]) => send(...a); },
  InvokeCommand: class { constructor(public input: Record<string, unknown>) {} },
  InvocationType: { Event: 'Event' },
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = jest.fn(); },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dispatchAmendedTurn } = require('../../lambda/src/lib/turn-triage');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas';
const USER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';

const call = (over: Record<string, unknown> = {}) => dispatchAmendedTurn({
  channelArn: CHANNEL,
  botArn: BOT,
  classification: 'premium',
  correlationId: 'turn-abc',
  senderArn: USER,
  userMessage: 'Write me a fifteen paragraph report on onboarding.',
  amendments: [{ messageId: 'm2', senderArn: USER, content: 'Actually, keep it to one page.', targeted: false }],
  // The audience of the answer this fold produces. Untargeted unless a case says otherwise.
  replyIsTargeted: false,
  fold: 1,
  ...over,
});

const sentTurn = () => JSON.parse(send.mock.calls[0][0].input.Payload.toString()).aeTurn;

beforeEach(() => {
  jest.clearAllMocks();
  send.mockResolvedValue({});
  process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:1:function:router-premium';
});

describe('an amendment reaches the work it amends', () => {
  it('runs the SAME turn again, so the person gets one answer and not two', async () => {
    expect(await call()).toBe(true);

    // The correlation is what makes this a continuation rather than a second answer: the placeholder
    // is already theirs and the lock is already held under this id.
    expect(sentTurn().correlationId).toBe('turn-abc');
  });

  it('carries the original request AND what they added', async () => {
    await call();
    const { userMessage } = sentTurn();

    // Both halves, or the re-run answers only the correction and loses what it was correcting.
    expect(userMessage).toContain('fifteen paragraph report');
    expect(userMessage).toContain('Actually, keep it to one page.');
  });

  it('asks for the request as amended rather than an answer plus a correction', async () => {
    await call();
    // A turn that answers the original and then corrects itself has shown the person the work they
    // already told us not to do, which is the outcome folding exists to avoid.
    expect(sentTurn().userMessage).toContain('AS AMENDED');
  });

  it('carries the fold count, which is the only thing bounding this', async () => {
    await call({ fold: 2 });
    // Without it the count resets on every re-dispatch and a person who keeps amending holds the
    // turn open indefinitely - the stranding tenet 2 forbids, reached by looking responsive.
    expect(sentTurn().amendedFold).toBe(2);
  });

  it('is not a triage turn, so the re-run answers instead of reading', async () => {
    await call();
    // Carrying a triage block would make the amended turn classify its own queue again rather than
    // do the work, and the person would get a reading where they asked for a report.
    expect(sentTurn().triage).toBeUndefined();
  });

  it('dispatches nothing when there is nothing to fold', async () => {
    expect(await call({ amendments: [] })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports failure rather than throwing, so the caller can deliver what it has', async () => {
    send.mockRejectedValue(new Error('throttled'));
    // The answer in hand is unamended but real. Losing it to an exception would replace a stale
    // answer with no answer.
    expect(await call()).toBe(false);
  });
});

describe('a privately addressed amendment is not published by the fold', () => {
  const PRIVATE = { messageId: 'm3', senderArn: USER, content: 'Actually, drop the salary section.', targeted: true };
  const PUBLIC = { messageId: 'm2', senderArn: USER, content: 'Actually, keep it to one page.', targeted: false };

  it('refuses the fold when the answer is one the room can read', async () => {
    // The fold inlines the amendment's own words and answers onto the placeholder the running turn
    // already has. Untargeted placeholder, public answer - so folding a targeted message publishes a
    // request its sender addressed to one assistant.
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await call({ amendments: [PRIVATE], replyIsTargeted: false })).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('refuses the WHOLE fold rather than quietly dropping the private one', async () => {
    // A silent drop would hide a caller fault and deliver an answer missing half the correction. The
    // caller filters first; reaching here with one at all is a bug worth seeing.
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await call({ amendments: [PUBLIC, PRIVATE], replyIsTargeted: false })).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('folds it when the answer goes to the same person', async () => {
    // Non-vacuity, and the case that must keep working: a private request answered privately has one
    // audience throughout, so there is nothing to publish.
    expect(await call({ amendments: [PRIVATE], replyIsTargeted: true })).toBe(true);
    expect(sentTurn().userMessage).toContain('drop the salary section');
  });

  it('folds an untargeted amendment into a public answer, as before', async () => {
    expect(await call({ amendments: [PUBLIC], replyIsTargeted: false })).toBe(true);
    expect(sentTurn().userMessage).toContain('keep it to one page');
  });
});
