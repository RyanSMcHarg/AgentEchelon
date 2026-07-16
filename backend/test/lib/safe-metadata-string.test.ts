/**
 * Chime message-Metadata budget guard (CLAUDE.md "Message delivery & size";
 * the thumbs join rides this Metadata).
 *
 * The bot message's Metadata is the SINGLE source for both the frontend
 * (modelId/intent/feedback + the experiment join keys) and the Aurora archival
 * pipeline (kinesis-archival reads the same Metadata). Chime caps it at 1024
 * ENCODED chars. safeMetadataString must keep every emitted blob within that
 * cap, and when a heavy turn would exceed it, shed low-priority keys while
 * PRESERVING the small high-value join + core-analytics keys (rather than
 * dropping the whole blob, which would silently break the join and analytics).
 *
 * This test is the standing "did we just blow the 1k limit?" check: a maximal
 * realistic metadata blob must come back within budget with the join intact.
 */

import { safeMetadataString, CHIME_METADATA_MAX } from '../../lambda/src/lib/async-processor-core';

const encodedLen = (s: string) => encodeURIComponent(s).length;

// A deliberately maximal NON-battle experiment turn: experiment join + config
// identity + active task + attachment + targetedSender + full analytics. If any
// future field pushes the must-keep core past the cap, this fails.
const maximal = (): Record<string, unknown> => ({
  messageNumber: 42,
  userType: 'premium',
  role: 'assistant',
  timestamp: '2026-06-20T00:00:00.000Z',
  agentType: 'premium',
  intent: 'report_generation',
  intentConfidence: '0.95',
  deliveryOption: 'structured_detailed',
  bedrockModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  inputTokens: 123456,
  outputTokens: 65432,
  latencyMs: 98765,
  totalMs: 123456,
  pollMs: 9999,
  activeTask: { type: 'report_generation', status: 'in_progress', label: 'Generating the Q4 regional revenue report' },
  wasFallback: true,
  fallbackReason: 'throttlingException_after_retries',
  retryCount: 3,
  experimentId: 'exp_3f9a2b7c-1d4e-4a8b-9c2d-7e6f5a4b3c2d',
  variantId: 'treatment',
  configId: 'cfg_a1b2c3d4e5f6',
  personaVersion: 'v2026-06-19a',
  intentPackVersion: 'v2026-06-19a',
  systemPromptHash: '9f86d081884c7d65',
  assignmentMode: 'probabilistic',
  attachment: { fileKey: 'uploads/premium/2026/06/20/a1b2c3d4-e5f6-7890-abcd-ef0123456789/quarterly-regional-revenue-report-final.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'quarterly-regional-revenue-report-final.xlsx' },
  targetedSender: 'arn:aws:chime:us-east-1:123456789012:app-instance/11111111-2222-3333-4444-555555555555/user/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
});

describe('safeMetadataString budget', () => {
  it('passes a normal blob through unchanged and within budget', () => {
    const normal = {
      messageNumber: 5, userType: 'premium', role: 'assistant',
      timestamp: '2026-06-20T00:00:00.000Z', intent: 'general',
      bedrockModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      inputTokens: 100, outputTokens: 200, assignmentMode: 'probabilistic',
    };
    const out = safeMetadataString(normal);
    expect(out).toBe(JSON.stringify(normal));
    expect(encodedLen(out!)).toBeLessThanOrEqual(CHIME_METADATA_MAX);
  });

  it('keeps a maximal heavy turn within the 1024 encoded cap', () => {
    const out = safeMetadataString(maximal());
    expect(out).toBeDefined();
    expect(encodedLen(out!)).toBeLessThanOrEqual(CHIME_METADATA_MAX);
  });

  it('preserves the experiment join + core analytics keys when shedding', () => {
    const out = safeMetadataString(maximal());
    const parsed = JSON.parse(out!);
    // The whole point of the join: these must survive a heavy turn.
    expect(parsed.experimentId).toBe('exp_3f9a2b7c-1d4e-4a8b-9c2d-7e6f5a4b3c2d');
    expect(parsed.variantId).toBe('treatment');
    expect(parsed.assignmentMode).toBe('probabilistic');
    // Core analytics + frontend display also survive.
    expect(parsed.intent).toBe('report_generation');
    expect(parsed.bedrockModel).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(parsed.inputTokens).toBe(123456);
    expect(parsed.outputTokens).toBe(65432);
  });

  it('returns undefined only as a last resort (an irreducibly huge blob)', () => {
    const huge = { intent: 'x'.repeat(2000) }; // a single core key beyond the cap
    expect(safeMetadataString(huge)).toBeUndefined();
  });

  it('returns undefined for empty/undefined input', () => {
    expect(safeMetadataString(undefined)).toBeUndefined();
  });
});
