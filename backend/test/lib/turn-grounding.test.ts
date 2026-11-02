/**
 * WHAT A TURN IS GROUNDED IN, AND WHAT IT REFUSES TO SPEND ON.
 *
 * Retrieval and the running summary moved off the pre-placeholder path and into the processor
 * (`what-waits-for-the-first-frame.test.ts` is the ratchet that keeps them there). The move must not
 * change what a turn is grounded in, and it must not change what a turn declines to pay for: a
 * deployment with no data plane and a message not worth grounding both still cost nothing.
 *
 * DEGRADATION IS THE POINT OF THE LAST CASE. The caller starts this promise and awaits it later, so a
 * rejection is an unhandled rejection rather than a missing hint. Both halves degrade to a safe value
 * of their own, and this pins that the pair does too.
 */
const retrieveContext = jest.fn();
const getLatestSummary = jest.fn();

jest.mock('../../lambda/src/lib/data-plane-client', () => ({
  retrieveContext: (...args: unknown[]) => retrieveContext(...args),
  getLatestSummary: (...args: unknown[]) => getLatestSummary(...args),
}));

import { resolveTurnGrounding, RAG_SOURCE_TYPES } from '../../lambda/src/lib/turn-grounding';
import { IntentType } from '../../lambda/src/lib/intent-classifier';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/conv';
const ask = (over: Record<string, unknown> = {}) => resolveTurnGrounding({
  channelArn: CHANNEL,
  userMessage: 'what did we agree about the pricing page',
  classification: 'premium',
  intent: IntentType.GENERAL,
  ...over,
});

const chunk = {
  sourceId: 'doc-1', sourceType: 'doc', title: 'Pricing', chunkIndex: 0, content: 'text', similarity: 0.6,
};

beforeEach(() => {
  retrieveContext.mockReset();
  getLatestSummary.mockReset();
  process.env.ENABLE_LIVE_DRIFT = 'true';
});

afterAll(() => { delete process.env.ENABLE_LIVE_DRIFT; });

describe('a turn with a data plane behind it', () => {
  it('carries both the chunks and the summary', async () => {
    retrieveContext.mockResolvedValue({ chunks: [chunk], citations: [], signalAvailable: true });
    getLatestSummary.mockResolvedValue('they picked the annual plan');

    await expect(ask()).resolves.toEqual({
      retrievedContext: { chunks: [chunk], citations: [], signalAvailable: true },
      conversationSummary: 'they picked the annual plan',
    });
  });

  it('asks every corpus this deployment ingests, scoped to the classification', async () => {
    retrieveContext.mockResolvedValue({ chunks: [chunk], citations: [], signalAvailable: true });
    getLatestSummary.mockResolvedValue(null);
    await ask();

    // The classification travels INDEPENDENTLY of the ladder derived from it (ADR-028): it selects the
    // database reader role, so retrieval can reject the pair if a mistake in the ladder disagrees with
    // the rank. Passing only the ladder would make a widening mistake unnoticeable.
    expect(retrieveContext).toHaveBeenCalledWith(expect.objectContaining({
      sourceTypes: [...RAG_SOURCE_TYPES],
      classification: 'premium',
    }));
  });

  it('reports an honest empty as no grounding at all, not as an empty result', async () => {
    // A hint built from zero chunks is a `## RETRIEVED CONTEXT` heading with nothing under it, which
    // reads to the model as "the corpus was searched and is empty about this".
    retrieveContext.mockResolvedValue({ chunks: [], citations: [], signalAvailable: true });
    getLatestSummary.mockResolvedValue(null);
    await expect(ask()).resolves.toEqual({});
  });
});

describe('what it declines to spend', () => {
  it('spends nothing without a data plane', async () => {
    delete process.env.ENABLE_LIVE_DRIFT;
    await expect(ask()).resolves.toEqual({});
    expect(retrieveContext).not.toHaveBeenCalled();
    expect(getLatestSummary).not.toHaveBeenCalled();
  });

  it.each([IntentType.GREETING, IntentType.ACKNOWLEDGMENT])(
    'spends nothing on %s - there is nothing to retrieve for "hi"',
    async (intent) => {
      await expect(ask({ intent })).resolves.toEqual({});
      expect(retrieveContext).not.toHaveBeenCalled();
      expect(getLatestSummary).not.toHaveBeenCalled();
    },
  );

  it('asks for no summary without a channel to ask about', async () => {
    retrieveContext.mockResolvedValue({ chunks: [], citations: [], signalAvailable: true });
    await ask({ channelArn: undefined });
    expect(getLatestSummary).not.toHaveBeenCalled();
  });
});

describe('a data plane that fails costs a hint, never the turn', () => {
  it('settles rather than rejecting when retrieval throws', async () => {
    retrieveContext.mockRejectedValue(new Error('data plane down'));
    getLatestSummary.mockResolvedValue('they picked the annual plan');
    await expect(ask()).resolves.toEqual({ conversationSummary: 'they picked the annual plan' });
  });
});
