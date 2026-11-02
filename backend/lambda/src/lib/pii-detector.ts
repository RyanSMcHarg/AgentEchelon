/**
 * THE DETECTOR THE DE-IDENTIFIED COPY IS MADE WITH, behind one interface (DESIGN-ADMIN-CONSOLE 5.3).
 *
 * Like every model call here, it is a replaceable function (tenet P3): the copy depends on `anonymize`,
 * not on a provider. The shipped default is an Amazon Bedrock guardrail whose sensitive-information
 * policy anonymizes every entity type it knows (`lib/config/deidentify-guardrail.ts`), applied with
 * `ApplyGuardrail`. That reuses what the deployment already runs - the guardrail construct, and the
 * Bedrock endpoint - rather than adding a service (tenet D8). A guardrail writes a terse tag (`{EMAIL}`)
 * in place of what it found; the copy shows a description of what was removed instead
 * (`[an email address removed]`, `describePlaceholders`).
 */
import { BedrockRuntimeClient, ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import { inGroups, type Anonymize } from './de-identify.js';
import { describePlaceholders, replacementFor } from '../../../lib/config/deidentify-guardrail.js';

/**
 * Replace each match in the text with its description, longest first so a full address is replaced
 * before a part of it could be. A match `replacementFor` keeps - a bare place name, a pseudonym the copy
 * put there - is left as written.
 */
export function applyMatches(text: string, matches: Array<{ match: string; type: string }>): string {
  const ordered = [...matches].sort((a, b) => b.match.length - a.match.length);
  return ordered.reduce((t, m) => {
    const replacement = replacementFor(m.type, m.match);
    return replacement === null ? t : t.split(m.match).join(replacement);
  }, text);
}

export interface PiiDetector {
  /** Recorded on each derived conversation, so a copy says what made it. */
  name: string;
  anonymize: Anonymize;
}

/**
 * Characters per `ApplyGuardrail` call. The service caps one request's text; grouping well below the cap
 * keeps every call valid while still paying for a conversation in a few requests rather than one per
 * message.
 */
const GROUP_CHARS = 10_000;

export function guardrailDetector(
  guardrailId: string,
  guardrailVersion: string,
  client: Pick<BedrockRuntimeClient, 'send'> = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' }),
): PiiDetector {
  const call = async (text: string): Promise<string> => {
    if (!text.trim()) return text;
    const res = await client.send(new ApplyGuardrailCommand({
      guardrailIdentifier: guardrailId,
      guardrailVersion,
      // OUTPUT, because the copy is text being shown to a reader, and the anonymize action applies to it.
      source: 'OUTPUT',
      content: [{ text: { text } }],
    }));
    // No intervention means nothing was found: the text stands as it was.
    if (res.action !== 'GUARDRAIL_INTERVENED') return text;
    // THE MATCHES, NOT THE REWRITE. The guardrail reports a city and a street address alike as
    // `ADDRESS`, so its own rewrite masks both. Applying each match here lets a bare place name stay
    // while a street address is still removed (`replacementFor`).
    const matches = (res.assessments ?? [])
      .flatMap((a) => a.sensitiveInformationPolicy?.piiEntities ?? [])
      .filter((e): e is { match: string; type: NonNullable<typeof e.type>; action: typeof e.action } => !!e.match && !!e.type);
    if (matches.length) return applyMatches(text, matches);
    // An intervention that reports no match: fall back to the guardrail's rewrite, which masks
    // everything, rather than keep text it changed for a reason it did not say.
    const outputs = (res.outputs ?? []).map((o) => o.text ?? '');
    // The policy only anonymizes, so an intervention is a rewrite. An empty answer would be a block,
    // which this policy cannot produce; refuse it rather than store nothing as if it were the text.
    if (!outputs.length) throw new Error('the de-identification guardrail intervened without returning text');
    return describePlaceholders(outputs.join(''));
  };
  return {
    name: `bedrock-guardrail:${guardrailId}:${guardrailVersion}`,
    anonymize: (texts) => inGroups(texts, GROUP_CHARS, call),
  };
}
