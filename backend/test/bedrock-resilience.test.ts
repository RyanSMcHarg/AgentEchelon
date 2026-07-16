/**
 * Unit tests for bedrock-resilience
 *
 * Tests circuit breaker, retry, fallback, and error classification logic.
 */

// Mock async-processor-core before importing
jest.mock('../lambda/src/lib/async-processor-core', () => ({
  invokeBedrock: jest.fn(),
}));

import { BedrockCircuitBreaker, invokeBedrockWithFallback, circuitBreaker } from '../lambda/src/lib/bedrock-resilience';
import { invokeBedrock } from '../lambda/src/lib/async-processor-core';

const mockInvoke = invokeBedrock as jest.MockedFunction<typeof invokeBedrock>;

const primaryConfig = {
  model: 'anthropic.claude-sonnet',
  maxTokens: 1024,
  userType: 'standard' as const,
};

const successResult = {
  response: 'Hello!',
  inputTokens: 10,
  outputTokens: 5,
  bedrockTime: 200,
  steps: [],
};

function makeError(name: string, code?: number) {
  const error = new Error(`${name} error`) as any;
  error.name = name;
  if (code) error.$metadata = { httpStatusCode: code };
  return error;
}

describe('BedrockCircuitBreaker', () => {
  let cb: BedrockCircuitBreaker;

  beforeEach(() => {
    cb = new BedrockCircuitBreaker();
  });

  it('starts closed', () => {
    expect(cb.isOpen('model-a')).toBe(false);
  });

  it('opens after 5 failures', () => {
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('model-a');
    }
    expect(cb.isOpen('model-a')).toBe(true);
  });

  it('stays closed under threshold', () => {
    for (let i = 0; i < 4; i++) {
      cb.recordFailure('model-a');
    }
    expect(cb.isOpen('model-a')).toBe(false);
  });

  it('resets on success', () => {
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('model-a');
    }
    cb.recordSuccess('model-a');
    expect(cb.isOpen('model-a')).toBe(false);
  });

  it('isolates models independently', () => {
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('model-a');
    }
    expect(cb.isOpen('model-a')).toBe(true);
    expect(cb.isOpen('model-b')).toBe(false);
  });

  it('resets after timeout (half-open)', () => {
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('model-a');
    }
    // Advance past the 60s reset window
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    expect(cb.isOpen('model-a')).toBe(false);
    jest.restoreAllMocks();
  });
});

describe('invokeBedrockWithFallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset circuit breaker state
    circuitBreaker.recordSuccess(primaryConfig.model);
    circuitBreaker.recordSuccess('fallback-model');
  });

  it('returns primary result on success', async () => {
    mockInvoke.mockResolvedValueOnce(successResult);

    const result = await invokeBedrockWithFallback(
      'system', [], primaryConfig, 'fallback-model'
    );

    expect(result.modelUsed).toBe('anthropic.claude-sonnet');
    expect(result.wasFallback).toBe(false);
    expect(result.retryCount).toBe(0);
    expect(result.response).toBe('Hello!');
  });

  it('retries on ThrottlingException then succeeds', async () => {
    mockInvoke
      .mockRejectedValueOnce(makeError('ThrottlingException', 429))
      .mockResolvedValueOnce(successResult);

    const result = await invokeBedrockWithFallback(
      'system', [], primaryConfig, 'fallback-model',
      { maxRetries: 2, baseDelayMs: 1 }
    );

    expect(result.modelUsed).toBe('anthropic.claude-sonnet');
    expect(result.retryCount).toBe(1);
    expect(result.wasFallback).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('falls back after retries exhausted', async () => {
    mockInvoke
      .mockRejectedValueOnce(makeError('ThrottlingException', 429))
      .mockRejectedValueOnce(makeError('ThrottlingException', 429))
      .mockRejectedValueOnce(makeError('ThrottlingException', 429))
      .mockResolvedValueOnce(successResult); // fallback succeeds

    const result = await invokeBedrockWithFallback(
      'system', [], primaryConfig, 'fallback-model',
      { maxRetries: 2, baseDelayMs: 1 }
    );

    expect(result.wasFallback).toBe(true);
    expect(result.fallbackReason).toBe('retries_exhausted');
    expect(result.modelUsed).toBe('fallback-model');
  });

  it('falls back immediately on ModelNotReadyException', async () => {
    mockInvoke
      .mockRejectedValueOnce(makeError('ModelNotReadyException'))
      .mockResolvedValueOnce(successResult);

    const result = await invokeBedrockWithFallback(
      'system', [], primaryConfig, 'fallback-model'
    );

    expect(result.wasFallback).toBe(true);
    expect(result.fallbackReason).toBe('model_unavailable');
    expect(mockInvoke).toHaveBeenCalledTimes(2); // 1 primary + 1 fallback
  });

  it('throws immediately on AccessDeniedException (no retry, no fallback)', async () => {
    mockInvoke.mockRejectedValueOnce(makeError('AccessDeniedException', 403));

    await expect(
      invokeBedrockWithFallback('system', [], primaryConfig, 'fallback-model')
    ).rejects.toThrow('AccessDeniedException error');

    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on ValidationException', async () => {
    mockInvoke.mockRejectedValueOnce(makeError('ValidationException', 400));

    await expect(
      invokeBedrockWithFallback('system', [], primaryConfig, 'fallback-model')
    ).rejects.toThrow('ValidationException error');

    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('forwards options.imageInput to invokeBedrock on the primary path (vision-in)', async () => {
    mockInvoke.mockResolvedValueOnce(successResult);
    const imageInput = { format: 'png' as const, bytes: new Uint8Array([1, 2, 3]) };

    await invokeBedrockWithFallback('system', [], primaryConfig, 'fallback-model', { imageInput });

    expect(mockInvoke).toHaveBeenCalledWith(
      'system',
      [],
      expect.objectContaining({ model: primaryConfig.model }),
      imageInput,
      undefined, // enableCompanyContextTool — off for this turn
      undefined, // enableEditTools (work-item propose-and-confirm) — off for this turn
      undefined, // documentInput (attachment-in) — no document on this turn
      undefined, // cacheableSystemPrefixLength — no prompt-cache prefix on this turn
    );
  });

  it('forwards options.imageInput to the fallback call too', async () => {
    mockInvoke
      .mockRejectedValueOnce(makeError('InternalServerException', 500))
      .mockResolvedValueOnce(successResult);
    const imageInput = { format: 'jpeg' as const, bytes: new Uint8Array([9]) };

    await invokeBedrockWithFallback('system', [], primaryConfig, 'fallback-model', { imageInput });

    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    expect(lastCall[3]).toBe(imageInput); // 4th arg on the fallback invoke
  });

  it('falls back on 500+ server errors', async () => {
    const serverError = makeError('InternalServerException', 500);
    mockInvoke
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce(successResult);

    const result = await invokeBedrockWithFallback(
      'system', [], primaryConfig, 'fallback-model'
    );

    expect(result.wasFallback).toBe(true);
    expect(result.fallbackReason).toBe('model_error');
  });

  it('skips primary when circuit is open', async () => {
    // Open the circuit
    for (let i = 0; i < 5; i++) {
      circuitBreaker.recordFailure(primaryConfig.model);
    }

    mockInvoke.mockResolvedValueOnce(successResult);

    const result = await invokeBedrockWithFallback(
      'system', [], primaryConfig, 'fallback-model'
    );

    expect(result.wasFallback).toBe(true);
    expect(result.fallbackReason).toBe('circuit_open');
    expect(mockInvoke).toHaveBeenCalledTimes(1); // only fallback
    expect(mockInvoke).toHaveBeenCalledWith(
      'system', [],
      expect.objectContaining({ model: 'fallback-model' }),
      // Phase-3 vision-in: the fallback path now forwards imageInput
      // (undefined when the turn has no image — a no-op in invokeBedrock).
      undefined,
      undefined, // enableCompanyContextTool
      undefined, // enableEditTools (work-item propose-and-confirm)
      undefined, // documentInput (attachment-in) — no document on this turn
      undefined, // cacheableSystemPrefixLength — no prompt-cache prefix on this turn
    );
  });

  it('tries primary anyway if circuit open but no fallback available', async () => {
    for (let i = 0; i < 5; i++) {
      circuitBreaker.recordFailure(primaryConfig.model);
    }

    mockInvoke.mockResolvedValueOnce(successResult);

    const result = await invokeBedrockWithFallback(
      'system', [], primaryConfig, null
    );

    expect(result.wasFallback).toBe(false);
    expect(result.modelUsed).toBe('anthropic.claude-sonnet');
  });

  it('throws when all models fail', async () => {
    mockInvoke
      .mockRejectedValueOnce(makeError('ModelErrorException'))
      .mockRejectedValueOnce(makeError('ModelErrorException')); // fallback also fails

    await expect(
      invokeBedrockWithFallback('system', [], primaryConfig, 'fallback-model')
    ).rejects.toThrow();
  });

  it('throws when no fallback and primary fails with non-retryable error', async () => {
    mockInvoke.mockRejectedValueOnce(makeError('ModelNotReadyException'));

    await expect(
      invokeBedrockWithFallback('system', [], primaryConfig, null)
    ).rejects.toThrow('ModelNotReadyException error');
  });
});
