/**
 * Delivery Options Unit Tests
 */

// Virtual mock — module only exists at Lambda runtime (bundled by CDK)
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
  ConverseCommand: jest.fn(),
}), { virtual: true });

import { IntentType } from '../lambda/src/lib/intent-classifier';
import {
  DeliveryOption,
  selectDeliveryOption,
  getQuickResponse,
  getTaskPlaceholder,
} from '../lambda/src/lib/delivery-options';

describe('selectDeliveryOption', () => {
  describe('without active task', () => {
    it('returns DIRECT for GREETING', () => {
      expect(selectDeliveryOption(IntentType.GREETING, false)).toBe(DeliveryOption.DIRECT);
    });

    it('returns DIRECT for ACKNOWLEDGMENT', () => {
      expect(selectDeliveryOption(IntentType.ACKNOWLEDGMENT, false)).toBe(DeliveryOption.DIRECT);
    });

    it('returns TASK_MULTI_STEP for GUIDED_TROUBLESHOOTING', () => {
      expect(selectDeliveryOption(IntentType.GUIDED_TROUBLESHOOTING, false)).toBe(DeliveryOption.TASK_MULTI_STEP);
    });

    it('returns TASK_MULTI_STEP for DATA_EXTRACTION', () => {
      expect(selectDeliveryOption(IntentType.DATA_EXTRACTION, false)).toBe(DeliveryOption.TASK_MULTI_STEP);
    });

    it('returns TASK_MULTI_STEP for REPORT_GENERATION', () => {
      expect(selectDeliveryOption(IntentType.REPORT_GENERATION, false)).toBe(DeliveryOption.TASK_MULTI_STEP);
    });

    it('returns PLACEHOLDER_UPDATE for GENERAL', () => {
      expect(selectDeliveryOption(IntentType.GENERAL, false)).toBe(DeliveryOption.PLACEHOLDER_UPDATE);
    });
  });

  describe('with active task', () => {
    it('returns TASK_MULTI_STEP for GENERAL when task is active', () => {
      expect(selectDeliveryOption(IntentType.GENERAL, true)).toBe(DeliveryOption.TASK_MULTI_STEP);
    });

    it('still returns DIRECT for GREETING even with active task', () => {
      expect(selectDeliveryOption(IntentType.GREETING, true)).toBe(DeliveryOption.DIRECT);
    });
  });
});

describe('getQuickResponse', () => {
  it.each(['hi', 'hello', 'hey', 'good morning'])(
    'returns greeting response for "%s"',
    (msg) => {
      const response = getQuickResponse('greeting', msg);
      expect(response).toBe('Hey, what can I help you with?');
    }
  );

  it.each(['thanks', 'thank you'])(
    'returns thank-you response for "%s"',
    (msg) => {
      const response = getQuickResponse('acknowledgment', msg);
      expect(response).toContain('Happy to help');
    }
  );

  it.each(['ok', 'okay', 'got it', 'great', 'perfect', 'cool'])(
    'returns acknowledgment response for "%s"',
    (msg) => {
      const response = getQuickResponse('acknowledgment', msg);
      expect(response).toContain('other questions');
    }
  );

  it('returns goodbye response', () => {
    expect(getQuickResponse('acknowledgment', 'bye')).toContain('Goodbye');
    expect(getQuickResponse('acknowledgment', 'goodbye')).toContain('Goodbye');
  });

  it('returns null for unrecognized messages', () => {
    expect(getQuickResponse('general', 'What is AI?')).toBeNull();
  });

  it('strips trailing punctuation before matching', () => {
    expect(getQuickResponse('greeting', 'hello!')).toBe('Hey, what can I help you with?');
    expect(getQuickResponse('acknowledgment', 'thanks?')).toContain('Happy to help');
  });
});

describe('getTaskPlaceholder', () => {
  it('returns troubleshooting placeholders by status', () => {
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'guided_troubleshooting', 'collecting_symptoms'))
      .toContain('understand');
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'guided_troubleshooting', 'diagnosing'))
      .toContain('Analyzing');
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'guided_troubleshooting', 'proposing_solutions'))
      .toContain('solutions');
  });

  it('returns data extraction placeholders by status', () => {
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'data_extraction', 'extracting'))
      .toContain('Extracting');
  });

  it('returns report generation placeholders by status', () => {
    expect(getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP, 'report_generation', 'generating'))
      .toContain('Generating');
  });

  it('returns generic placeholder for unknown task type', () => {
    const result = getTaskPlaceholder(DeliveryOption.TASK_MULTI_STEP);
    expect(result).toBeTruthy();
  });

  it('returns "One moment..." for PLACEHOLDER_UPDATE', () => {
    expect(getTaskPlaceholder(DeliveryOption.PLACEHOLDER_UPDATE)).toBe('One moment...');
  });
});
