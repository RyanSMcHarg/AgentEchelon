/**
 * Map a Bedrock modelId to a short human-readable label for display in
 * message headers and badges. The router can pick different models per
 * intent within the same tier, so the model-that-actually-responded is
 * per-message metadata — never derive it from the conversation.
 *
 * Examples:
 *   anthropic.claude-opus-4-6-v1       → Opus
 *   anthropic.claude-sonnet-4-6        → Sonnet
 *   anthropic.claude-3-haiku-20240307  → Haiku
 *   amazon.titan-text-premier-v1:0     → Titan
 *   openai.gpt-oss-120b                → GPT-OSS
 */
export function shortenModelId(modelId: string | undefined | null): string | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();

  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('titan')) return 'Titan';
  if (lower.includes('gpt-oss')) return 'GPT-OSS';
  if (lower.includes('gpt')) return 'GPT';

  // Fallback: last segment, capitalized
  const lastSegment = modelId.split(/[.:/-]/).filter(Boolean).pop() || modelId;
  return lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1);
}
