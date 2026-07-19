/**
 * Drift DECISION via reasoning (ADR-013).
 *
 * The drift *decision* -- "has this message drifted from the conversation's
 * established purpose, or is it a relevant tangent that belongs here?" -- is a
 * REASONING judgment, not a similarity score. SPEC-DRIFT-CONVERGENCE made the
 * decision `cosine_distance(message_embedding, summary_embedding)` against a
 * threshold; that approach was evaluated and rejected here: embedding similarity
 * is too blunt -- semantically similar messages can mean
 * very different things contextually; the judgment needed is inherently
 * reasoning, not similarity.
 * Example: "Do they have consulting roles too?" inside a job_opportunity
 * conversation is a relevant tangent, NOT drift -- cosine cannot tell the two
 * apart.
 *
 * So this module makes the decision with a cheap reasoning model (the same Haiku
 * the intent classifier uses), judging the new message against the conversation
 * PURPOSE. The purpose comes from channel metadata (the `topic` set at creation;
 * see SPEC-WELCOME-AND-CONTEXT), so this needs NO Aurora and NO VPC -- the reply
 * handler stays out of the VPC and keeps its Chime egress (the bug ADR-013
 * fixes). It can run in Athena mode too.
 *
 * RETRIEVAL (which existing conversation to redirect a confirmed drift to)
 * remains a similarity problem and stays on pgvector (`findRelatedConversations`,
 * SQL-scoped) -- that is the right tool for *that* sub-problem, and is only
 * needed on the rare drift-fire path, reachable via RDS Data API without a VPC.
 *
 * Fail-safe: on any model error or unparseable output the verdict is STAY ("no
 * drift this turn"), never a substring/keyword guess (memory
 * `feedback_no_string_matching`; SPEC-DRIFT principle 3). A false positive that
 * interrupts a relevant tangent erodes trust faster than a missed drift.
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Same cheap, deterministic model the intent classifier uses. Model-independent
// of the conversation's classification model, so the basic classification gets the same drift rigor
// as premium (ADR-013).
const REASONING_MODEL = process.env.DRIFT_REASONING_MODEL_ID
  || process.env.CLASSIFIER_MODEL_ID
  || 'anthropic.claude-3-haiku-20240307-v1:0';

// Messages shorter than this can't carry a topic shift worth acting on; skip the
// model call entirely (greetings, "ok", "thanks").
const MIN_MESSAGE_LENGTH = 12;

export interface DriftJudgeInput {
  /** The conversation's established purpose/topic (channel metadata `topic`). */
  conversationPurpose: string;
  /** The new user message to judge. */
  userMessage: string;
  /** The classified intent (IntentType value), for additional signal. */
  intent: string;
  /** Optional recent context (last summary / few messages) to ground the judge. */
  recentContext?: string;
}

export interface DriftJudgment {
  isDrift: boolean;
  /** Short model rationale (or a fixed reason on the fail-safe / skip paths). */
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
}

/** Indirection so the decision logic is unit-testable without the Bedrock SDK
 *  (which is only bundled at Lambda runtime). Returns the model's raw text. */
export type DriftJudgeInvoke = (prompt: string) => Promise<string>;

let _client: BedrockRuntimeClient | undefined;
function defaultInvoke(): DriftJudgeInvoke {
  return async (prompt: string) => {
    _client = _client || new BedrockRuntimeClient({ region: AWS_REGION });
    const response = await _client.send(new ConverseCommand({
      modelId: REASONING_MODEL,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 60, temperature: 0 },
    }));
    const out = response.output?.message?.content?.[0];
    return out && 'text' in out && out.text ? out.text : '';
  };
}

/** Build the reasoning prompt. Bias toward STAY when unsure (false positives
 *  erode trust). Asks for a one-token verdict + a short reason. */
export function buildDriftPrompt(input: DriftJudgeInput): string {
  const ctx = input.recentContext?.trim()
    ? `\nRecent context:\n${input.recentContext.trim()}\n`
    : '';
  return `You decide whether a new message belongs in the CURRENT conversation or has drifted to a genuinely different topic that deserves its own conversation.

The current conversation's purpose: "${input.conversationPurpose}"
${ctx}
A relevant tangent, follow-up question, clarification, or related sub-topic BELONGS here -> STAY.
A shift to a clearly different topic, goal, company, or task that would be cleaner as its own thread -> DRIFT.
When unsure, prefer STAY. A wrong "drift" interruption is worse than a missed one.

Classified intent of the new message: ${input.intent}
New message: "${input.userMessage}"

Answer in exactly this form:
VERDICT: DRIFT or STAY
REASON: <one short sentence>`;
}

/** Parse the model output. First VERDICT line wins; STAY/unparseable -> not drift. */
export function parseDriftVerdict(text: string): { isDrift: boolean; rationale: string } {
  const verdictMatch = /VERDICT:\s*(DRIFT|STAY)/i.exec(text);
  const reasonMatch = /REASON:\s*(.+)/i.exec(text);
  const rationale = reasonMatch?.[1]?.trim() || (verdictMatch ? '' : 'unparseable model output');
  if (!verdictMatch) return { isDrift: false, rationale };
  return { isDrift: verdictMatch[1].toUpperCase() === 'DRIFT', rationale };
}

/**
 * Judge whether the new message has drifted from the conversation's purpose.
 * Pure reasoning over channel-metadata purpose -- no Aurora, no VPC. Returns
 * `{ isDrift: false }` on short messages, missing purpose, model error, or
 * unparseable output (fail-safe).
 */
export async function judgeDrift(
  input: DriftJudgeInput,
  invoke: DriftJudgeInvoke = defaultInvoke(),
): Promise<DriftJudgment> {
  // Skip cheaply when there is nothing to judge against or nothing to judge.
  if (!input.conversationPurpose?.trim()) {
    return { isDrift: false, rationale: 'no conversation purpose available', confidence: 'low' };
  }
  if (!input.userMessage || input.userMessage.trim().length < MIN_MESSAGE_LENGTH) {
    return { isDrift: false, rationale: 'message too short to carry a topic shift', confidence: 'high' };
  }

  try {
    const text = await invoke(buildDriftPrompt(input));
    const { isDrift, rationale } = parseDriftVerdict(text);
    // A clean parsed verdict is medium confidence; reasoning is inherently
    // judgmental, so we never claim 'high' for a positive drift call.
    return { isDrift, rationale, confidence: isDrift ? 'medium' : 'high' };
  } catch (err) {
    console.warn('[DriftReasoning] judge failed, defaulting to no-drift:', err);
    return { isDrift: false, rationale: 'model error -> no drift this turn', confidence: 'low' };
  }
}
