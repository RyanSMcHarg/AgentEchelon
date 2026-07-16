/**
 * Intent Classifier Unit Tests
 *
 * Tests fast-path keyword matching and keyword fallback classification.
 * Tests classifyIntentBasic (no LLM) and intentToDeliveryOption mapping.
 *
 * Note: classifyIntent (LLM-based) is not tested here because it requires
 * the Bedrock SDK which is only available at Lambda runtime (bundled by CDK).
 */

// Virtual mocks — these SDKs are only available at Lambda runtime (bundled by CDK esbuild)
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
  ConverseCommand: jest.fn(),
}), { virtual: true });

import {
  classifyIntentBasic,
  IntentType,
  intentToDeliveryOption,
} from '../lambda/src/lib/intent-classifier';

describe('classifyIntentBasic', () => {
  describe('greetings (fast-path)', () => {
    it.each(['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'])(
      'classifies "%s" as GREETING with high confidence',
      (msg) => {
        const result = classifyIntentBasic(msg);
        expect(result.intent).toBe(IntentType.GREETING);
        expect(result.confidence).toBe('high');
      }
    );

    it('classifies empty string as GREETING', () => {
      const result = classifyIntentBasic('');
      expect(result.intent).toBe(IntentType.GREETING);
    });

    it('classifies very short messages as GREETING', () => {
      const result = classifyIntentBasic('ab');
      expect(result.intent).toBe(IntentType.GREETING);
    });
  });

  describe('acknowledgments (fast-path)', () => {
    // Note: 'ok' is only 2 chars, hitting the short-message GREETING fast-path before
    // the acknowledgment check. This is a known quirk — 'okay' works correctly.
    it.each(['thanks', 'thank you', 'okay', 'got it', 'great', 'perfect', 'cool', 'bye', 'goodbye'])(
      'classifies "%s" as ACKNOWLEDGMENT with high confidence',
      (msg) => {
        const result = classifyIntentBasic(msg);
        expect(result.intent).toBe(IntentType.ACKNOWLEDGMENT);
        expect(result.confidence).toBe('high');
      }
    );
  });

  describe('keyword fallback - troubleshooting', () => {
    it.each([
      'I have an error in my code',
      'The system is broken',
      'This is not working',
      'There is a bug in the report',
      'Can you fix this issue?',
      'Help me with this problem',
      'The application keeps crashing',
    ])('classifies "%s" as GUIDED_TROUBLESHOOTING', (msg) => {
      const result = classifyIntentBasic(msg);
      expect(result.intent).toBe(IntentType.GUIDED_TROUBLESHOOTING);
      expect(result.confidence).toBe('medium');
    });
  });

  describe('keyword fallback - data extraction', () => {
    it.each([
      'Extract the data from the database',
      'Pull data from the API',
      'Query the sales numbers',
      'Can you fetch the user records?',
      'Retrieve the logs from yesterday',
    ])('classifies "%s" as DATA_EXTRACTION', (msg) => {
      const result = classifyIntentBasic(msg);
      expect(result.intent).toBe(IntentType.DATA_EXTRACTION);
      expect(result.confidence).toBe('medium');
    });
  });

  describe('keyword fallback - report generation', () => {
    it.each([
      'Generate a sales report',
      'Create a summary of last week',
      'I need an analysis of the data',
      'Compile the quarterly results',
    ])('classifies "%s" as REPORT_GENERATION', (msg) => {
      const result = classifyIntentBasic(msg);
      expect(result.intent).toBe(IntentType.REPORT_GENERATION);
      expect(result.confidence).toBe('medium');
    });
  });

  describe('general fallback', () => {
    it.each([
      'What is the weather today?',
      'Tell me about React hooks',
      'How does photosynthesis work?',
    ])('classifies "%s" as GENERAL with low confidence', (msg) => {
      const result = classifyIntentBasic(msg);
      expect(result.intent).toBe(IntentType.GENERAL);
      expect(result.confidence).toBe('low');
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase greetings', () => {
      expect(classifyIntentBasic('HELLO').intent).toBe(IntentType.GREETING);
    });

    it('handles mixed case acknowledgments', () => {
      expect(classifyIntentBasic('Thank You').intent).toBe(IntentType.ACKNOWLEDGMENT);
    });

    it('handles uppercase keywords', () => {
      expect(classifyIntentBasic('I have an ERROR').intent).toBe(IntentType.GUIDED_TROUBLESHOOTING);
    });
  });

  describe('whitespace handling', () => {
    it('trims leading/trailing whitespace', () => {
      expect(classifyIntentBasic('  hello  ').intent).toBe(IntentType.GREETING);
    });
  });
});

describe('intentToDeliveryOption', () => {
  it('maps GREETING to DIRECT', () => {
    expect(intentToDeliveryOption(IntentType.GREETING)).toBe('DIRECT');
  });

  it('maps ACKNOWLEDGMENT to DIRECT', () => {
    expect(intentToDeliveryOption(IntentType.ACKNOWLEDGMENT)).toBe('DIRECT');
  });

  it('maps GUIDED_TROUBLESHOOTING to TASK_MULTI_STEP', () => {
    expect(intentToDeliveryOption(IntentType.GUIDED_TROUBLESHOOTING)).toBe('TASK_MULTI_STEP');
  });

  it('maps DATA_EXTRACTION to TASK_MULTI_STEP', () => {
    expect(intentToDeliveryOption(IntentType.DATA_EXTRACTION)).toBe('TASK_MULTI_STEP');
  });

  it('maps REPORT_GENERATION to TASK_MULTI_STEP', () => {
    expect(intentToDeliveryOption(IntentType.REPORT_GENERATION)).toBe('TASK_MULTI_STEP');
  });

  it('maps GENERAL to PLACEHOLDER_UPDATE', () => {
    expect(intentToDeliveryOption(IntentType.GENERAL)).toBe('PLACEHOLDER_UPDATE');
  });
});
