/**
 * AN ACKNOWLEDGMENT ONLY ACKNOWLEDGES.
 *
 * "Please make a note of this for later in our conversation: the cutover date for the billing migration is
 * March 14. Just confirm you have noted it." is not an acknowledgment: labeled one, the turn would be answered from
 * the quick-acknowledgment template ("Let me know if you have other questions.") and the model would never read the
 * fact (`tests/e2e/agent-intents.spec.ts`, Basic follow-up). A prompt describing an acknowledgment as a
 * "confirmation that asks nothing" leads the model to read "confirm" in such a request as one.
 *
 * The prompt says an acknowledgment is a message that only acknowledges, and that one telling the
 * assistant something new or asking it to do anything is never an acknowledgment. The model decides (tenet
 * D11); this test holds the prompt to saying so.
 *
 * Measured on the classifier model (us.anthropic.claude-haiku-4-5-20251001-v1:0, temperature 0, the default
 * intent pack), the "confirmation that asks nothing" line vs this one:
 *   - the cutover message: ACKNOWLEDGMENT x3 -> GENERAL x3
 *   - "Noted, thanks. Also, the vendor call moved to Friday.": ACKNOWLEDGMENT_THANKS x3 -> GENERAL x3
 *   - unchanged: "ok", "okay", "got it", "perfect", "sounds good", "d'accord", "entendido", "好的" stay
 *     ACKNOWLEDGMENT; "thanks", "thank you so much", "merci beaucoup", "谢谢" stay ACKNOWLEDGMENT_THANKS;
 *     "bye", "ok thanks, bye" stay ACKNOWLEDGMENT_FAREWELL; "The budget for the project is 40k. Got it?" and
 *     "Can you confirm you received the file?" stay GENERAL.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ input })),
}), { virtual: true });
jest.mock('../../lambda/src/lib/assistant-session', () => ({
  sessionClient: (Ctor: new (cfg: unknown) => unknown, cfg: unknown) => new Ctor(cfg),
}));

import { classifyIntent, IntentType } from '../../lambda/src/lib/intent-classifier';
import { DEFAULT_INTENT_PACK } from '../../lambda/src/lib/intent-pack';

const NOTE_THIS = 'Please make a note of this for later in our conversation: the cutover date for the billing '
  + 'migration is March 14. Just confirm you have noted it.';

function promptSent(): string {
  const input = mockSend.mock.calls.at(-1)?.[0]?.input;
  return input.messages[0].content[0].text as string;
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ output: { message: { content: [{ text: 'GENERAL' }] } }, usage: {} });
});

describe('the classifier prompt tells an acknowledgment from a message that asks something', () => {
  it('says each kind of acknowledgment is a message that only acknowledges', async () => {
    await classifyIntent(NOTE_THIS, { pack: DEFAULT_INTENT_PACK });
    const prompt = promptSent();
    expect(prompt).toMatch(/- ACKNOWLEDGMENT_THANKS: The person only thanks you/);
    expect(prompt).toMatch(/- ACKNOWLEDGMENT_FAREWELL: The person only says goodbye/);
    expect(prompt).toMatch(/- ACKNOWLEDGMENT: The person only acknowledges what was said/);
  });

  it('says a message that tells something new or asks for anything, confirming included, is never one', async () => {
    await classifyIntent(NOTE_THIS, { pack: DEFAULT_INTENT_PACK });
    expect(promptSent()).toContain(
      'A message that tells you something new, or asks you to do anything (including to note, remember or '
      + 'confirm something), is never an acknowledgment of any kind',
    );
  });

  it('no longer calls an acknowledgment a "confirmation", the word the model matched', async () => {
    await classifyIntent(NOTE_THIS, { pack: DEFAULT_INTENT_PACK });
    expect(promptSent()).not.toMatch(/Other confirmations that ask nothing/);
  });

  it('sends the message to the model, and the label the model returns is the one used', async () => {
    const out = await classifyIntent(NOTE_THIS, { pack: DEFAULT_INTENT_PACK });
    expect(promptSent()).toContain(NOTE_THIS);
    expect(out.intent).toBe(IntentType.GENERAL);
  });
});
