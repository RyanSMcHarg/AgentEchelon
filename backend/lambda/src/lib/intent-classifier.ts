/**
 * Intent Classifier using Bedrock
 *
 * Uses LLM (Haiku) to classify user intent before selecting delivery option.
 * Fast-path exact matching for greetings/acknowledgments avoids LLM call.
 *
 * Flow:
 * 1. Handler receives message
 * 2. Call this classifier to detect intent
 * 3. Based on classified intent, select delivery option
 * 4. Execute appropriate response flow
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  classifyByPackKeywords,
  deliveryClassForIntent,
  getIntentPack,
  intentPackCategoryLines,
  knownIntentKeys,
  type IntentDef,
  type IntentPack,
} from './intent-pack.js';
import { UTILITY_MODEL_ID } from '../../../lib/config/model-strategy.js';
import { sessionClient } from './assistant-session.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const bedrockClient = sessionClient(BedrockRuntimeClient, { region: AWS_REGION });

// Haiku for fast, cheap classification
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL_ID || UTILITY_MODEL_ID;

/**
 * The UNIVERSAL intents (domain-independent). Domain intents now come from the deployment's
 * intent pack (lib/intent-pack.ts) — the DEFAULT pack still carries the historical enterprise
 * intents, so `IntentType.GUIDED_TROUBLESHOOTING` etc. remain valid keys for default deployments.
 * Kept as an enum for back-compat: existing consumers compare `classification.intent` against
 * these members. `IntentClassification.intent` is now `string` (a universal value OR a pack key).
 */
export enum IntentType {
  GREETING = 'greeting',
  ACKNOWLEDGMENT = 'acknowledgment',
  GUIDED_TROUBLESHOOTING = 'guided_troubleshooting',
  DATA_EXTRACTION = 'data_extraction',
  REPORT_GENERATION = 'report_generation',
  GENERAL = 'general',
  CONVERSATION_SUMMARY = 'conversation_summary',
  SET_PREFERENCE = 'set_preference',
  SHOW_PREFERENCES = 'show_preferences',
  OFF_TOPIC = 'off_topic',
}

/**
 * Classification result. `intent` is an intent KEY: one of the universal keys
 * ('greeting' | 'acknowledgment' | 'general') or a domain key from the active intent pack.
 */
export interface IntentClassification {
  intent: string;
  confidence: 'high' | 'medium' | 'low';
  /**
   * Classifier-step instrumentation. Set only
   * when the LLM path ran (absent on the no-LLM fast paths and the keyword
   * fallback). `classifierModelId` reflects the actual model used — the default
   * CLASSIFIER_MODEL, or a classification A/B experiment's variant model.
   */
  classifierModelId?: string;
  classifierLatencyMs?: number;
  classifierTokensIn?: number;
  classifierTokensOut?: number;
  /**
   * The request is for a platform intent this assistant does not offer (`ClassifyIntentOptions.refused`),
   * and the turn is refused rather than answered (DESIGN-CAPABILITY-REFUSAL). Only the model sets it.
   */
  refused?: boolean;
  /**
   * WHICH ACKNOWLEDGMENT IT IS, decided here, once, and carried as data (tenet D11, ADR-062 decision 7): thanks,
   * a farewell, or another confirmation. The reply is the `quick-acknowledgment` template's form for it, so
   * nothing downstream reads the person's words to choose a line. Set only on an acknowledgment.
   */
  acknowledgment?: AcknowledgmentKind;
}

/** The kinds of acknowledgment the classifier tells apart. */
export type AcknowledgmentKind = 'thanks' | 'farewell' | 'confirmation';

/** Options for {@link classifyIntent}. */
export interface ClassifyIntentOptions {
  /**
   * Override the classifier model id (a classification A/B experiment's variant
   * model). Absent ⇒ the deployment default CLASSIFIER_MODEL.
   */
  modelId?: string;
  /**
   * The taxonomy to classify against. Absent => the deployment pack (`getIntentPack()`).
   *
   * THE CALLER SUPPLIES IT BECAUSE THE CALLER KNOWS WHICH ASSISTANT IS ANSWERING. A pack rides the
   * profile version (SPEC-PORTABLE-PROFILES), so two assistants serving one classification can
   * recognize different intents, and a module-level singleton cannot express that.
   *
   * The classifier replay passes it too, so it asks the question production asks: `runReplayBody` in
   * `analytics-aurora/classifier-replay.ts` classifies both candidates against the pack the assistant
   * under test serves, which the non-VPC starter resolves (`classifier-replay-start.ts`) and the run
   * keeps. Falling through to the ambient `getIntentPack()` instead would measure a task neither model
   * performs in production while the concordance still read as a clean result: agreement between two
   * models sharing a prompt and a taxonomy is evidence of consistency, never of correctness.
   */
  pack?: IntentPack;
  /**
   * PLATFORM INTENTS THIS ASSISTANT DOES NOT OFFER (`refusedPlatformIntents`), offered to the model as
   * categories so a request for one is recognized for what it is and refused, instead of landing on
   * GENERAL and being answered as something else (DESIGN-CAPABILITY-REFUSAL §3).
   *
   * THE MODEL ONLY (tenet D11). They are never added to the keyword path, which is a substring match: a
   * refusal decided by a matched word would fire on "report the status of X". So a keyword-mode
   * profile, and the keyword fallback when the model call fails, refuse nothing and answer as before.
   */
  refused?: IntentDef[];
  /**
   * WORK THIS PERSON HAS OPEN HERE, waiting on them: each task's type and the step it is at.
   *
   * Without it the model reads the message alone, so "deliver it as a downloadable document", sent while
   * a data extraction waits at `validating`, reads as a new report request: the router then opens a second
   * task and strands the first (found live 2026-10-26). The model is told what is waiting and decides
   * whether the message continues it (tenet D11: the component that understands the message decides).
   * Only a type the classified pack serves is offered; the router's `opensOtherWorkThan` still decides
   * from the label, so nothing here bypasses it.
   */
  waitingWork?: { taskType: string; step?: string }[];
}

/** At most this many waiting tasks are named to the classifier; a person rarely owes more. */
const MAX_WAITING_WORK = 3;

/** The prompt lines naming the work waiting on the person, or '' when there is none the pack serves. */
export function waitingWorkLines(waiting: ClassifyIntentOptions['waitingWork'], servedKeys: Set<string>): string {
  const named = (waiting ?? [])
    .filter((w) => servedKeys.has(w.taskType))
    .slice(0, MAX_WAITING_WORK)
    .map((w) => `- ${w.taskType.toUpperCase()}${w.step && /^[a-z0-9_]{1,64}$/.test(w.step) ? `, at its step "${w.step}"` : ''}`);
  if (!named.length) return '';
  return `\nThe person has work open here, waiting on them or still being done for them:\n${named.join('\n')}\n`
    + 'When the message answers, approves, corrects or asks to finish that work, classify it as that work\'s category, '
    + 'even when it uses words that fit another category (a "report", a "document", a "table"). '
    + 'Classify it as another category only when it asks for something new.\n';
}

/** Messages short enough, or fixed enough, that no model is worth asking. */
const EXACT_GREETINGS = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'];
/** The fast path's acknowledgments, each with the kind it is. */
const EXACT_ACKNOWLEDGMENTS: Readonly<Record<string, AcknowledgmentKind>> = {
  thanks: 'thanks', 'thank you': 'thanks',
  ok: 'confirmation', okay: 'confirmation', 'got it': 'confirmation', great: 'confirmation', perfect: 'confirmation', cool: 'confirmation',
  bye: 'farewell', goodbye: 'farewell',
};

/**
 * The pre-LLM fast paths, or null when the message needs a model.
 *
 * Extracted because two things need to agree about it. The classifier itself takes these paths, and
 * the classification shadow gate (DESIGN §5) must EXCLUDE the messages that take them: no model is
 * consulted, so both candidates would "agree" on every one, and counting them would pad the corpus
 * with pairs that could never distinguish the two while shrinking the accuracy difference between
 * them. Duplicating the lists to answer that question would let the gate's idea of a fast path drift
 * from the classifier's.
 */
export function fastPathIntent(userMessage: string): IntentClassification | null {
  const message = userMessage.trim().toLowerCase();
  if (!message || message.length < 3) return { intent: IntentType.GREETING, confidence: 'high' };
  if (EXACT_GREETINGS.includes(message)) return { intent: IntentType.GREETING, confidence: 'high' };
  const kind = Object.prototype.hasOwnProperty.call(EXACT_ACKNOWLEDGMENTS, message) ? EXACT_ACKNOWLEDGMENTS[message] : undefined;
  if (kind) return { intent: IntentType.ACKNOWLEDGMENT, confidence: 'high', acknowledgment: kind };
  return null;
}

/**
 * Classify user message intent using Bedrock
 * Fast call to Haiku (or a classification-experiment variant model) for intent
 * detection before selecting response pattern.
 */
export async function classifyIntent(
  userMessage: string,
  opts?: ClassifyIntentOptions,
): Promise<IntentClassification> {
  const fastPath = fastPathIntent(userMessage);
  if (fastPath) return fastPath;

  // Use LLM for more complex classification. Categories come from the active intent pack —
  // the universal three plus the deployment's domain intents — so a deployment with a domain pack
  // classifies "pull the Q3 numbers from this sheet" as `data_extraction`, not the generic `GENERAL`.
  try {
    const pack = opts?.pack ?? getIntentPack();
    // A key the served pack declares is never refused, whatever the caller passed.
    const servedKeys = knownIntentKeys(pack);
    const refused = (opts?.refused ?? []).filter((d) => !servedKeys.has(d.key));
    const classificationPrompt = `Classify the following user message into one of these intent categories. Return ONLY the category name, nothing else.

Categories:
- GREETING: ONLY pure greetings with no question or topic — "hi", "hello", "hey there". If the message contains ANY question, request, or topic beyond the greeting, classify as GENERAL instead.
- ACKNOWLEDGMENT_THANKS: The person thanks you and asks nothing else, like "thanks", "thank you"
- ACKNOWLEDGMENT_FAREWELL: The person says goodbye and asks nothing else, like "bye", "goodbye"
- ACKNOWLEDGMENT: Other confirmations that ask nothing, like "ok", "got it"
- CONVERSATION_SUMMARY: Summarize, recap or catch the person up on THIS conversation - what was discussed, decided or asked here (e.g. "summarize what we discussed", "what did I miss?"). Answered from the conversation itself; this is never REPORT_GENERATION, even when the person says "summary" or "report"
- SET_PREFERENCE: The person asks for a LASTING change to how they are answered in every conversation, or answers an offer to set one (e.g. "from now on just give me the number", "always explain what it means", "change my answer style", "no preference"). A request about the CURRENT answer only ("just give me the number for Q2") is not this
- SHOW_PREFERENCES: The person asks what their saved preferences are, or how they are set to be answered (e.g. "what are my preferences?", "how do you answer me?")
${intentPackCategoryLines(pack)}${refused.length ? `\n${intentPackCategoryLines({ intents: refused })}` : ''}
- OFF_TOPIC: A request unrelated to every category above that is not ordinary conversation either (e.g. trivia, creative writing, advice on an unrelated subject). Small talk, questions about this conversation, and anything a category above covers are not this
- GENERAL: General questions, requests, or other inquiries that don't fit the above categories
${waitingWorkLines(opts?.waitingWork, servedKeys)}
User message: "${userMessage}"

Category:`;

    // Classifier model: a classification A/B experiment's variant model when
    // supplied, else the deployment default.
    const modelId = opts?.modelId || CLASSIFIER_MODEL;
    const startedAt = Date.now();
    const response = await bedrockClient.send(new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: classificationPrompt }] }],
      inferenceConfig: {
        maxTokens: 20,
        temperature: 0,
      },
    }));
    // Classifier-step instrumentation — latency + tokens, so a classification
    // experiment can be measured on cost and latency.
    const instrumentation = {
      classifierModelId: modelId,
      classifierLatencyMs: Date.now() - startedAt,
      classifierTokensIn: response.usage?.inputTokens,
      classifierTokensOut: response.usage?.outputTokens,
    };

    const outputContent = response.output?.message?.content?.[0];
    let category = '';
    if (outputContent && 'text' in outputContent && outputContent.text) {
      category = outputContent.text.trim().toUpperCase();
    }

    console.log('[IntentClassifier] LLM classification:', {
      userMessage: userMessage.substring(0, 50), category, ...instrumentation,
    });

    // The model returns the UPPERCASE category name; intent keys are lowercase. Match against the
    // active pack's known keys (universal + domain); unknown ⇒ GENERAL.
    const key = category.toLowerCase();
    let intent: string = IntentType.GENERAL;
    let confidence: IntentClassification['confidence'] = 'medium';
    if (key === 'greeting') { intent = IntentType.GREETING; confidence = 'high'; }
    else if (key === 'acknowledgment') return { intent: IntentType.ACKNOWLEDGMENT, confidence: 'high', acknowledgment: 'confirmation', ...instrumentation };
    else if (key === 'acknowledgment_thanks') return { intent: IntentType.ACKNOWLEDGMENT, confidence: 'high', acknowledgment: 'thanks', ...instrumentation };
    else if (key === 'acknowledgment_farewell') return { intent: IntentType.ACKNOWLEDGMENT, confidence: 'high', acknowledgment: 'farewell', ...instrumentation };
    else if (key === 'general') { intent = IntentType.GENERAL; confidence = 'medium'; }
    else if (key === 'conversation_summary') { intent = IntentType.CONVERSATION_SUMMARY; confidence = 'high'; }
    else if (key === 'set_preference') { intent = IntentType.SET_PREFERENCE; confidence = 'high'; }
    else if (key === 'show_preferences') { intent = IntentType.SHOW_PREFERENCES; confidence = 'high'; }
    else if (key === 'off_topic') { intent = IntentType.OFF_TOPIC; confidence = 'high'; }
    else if (servedKeys.has(key)) { intent = key; confidence = 'high'; }
    else if (refused.some((d) => d.key === key)) {
      return { intent: key, confidence: 'high', refused: true, ...instrumentation };
    }
    return { intent, confidence, ...instrumentation };
  } catch (error) {
    console.error('[IntentClassifier] LLM classification failed:', error);
    return classifyByKeywords(userMessage);
  }
}

/**
 * ONE SHORT READING FROM THE CLASSIFIER MODEL, for a caller that owns its prompt and its parser.
 *
 * The same client and the same model resolution `classifyIntent` uses, so a profile's classifier
 * choice (or a classification experiment's variant) governs every reading taken on the router path,
 * not only the intent label. Used by the stop question's follow-up (`stop-evaluation.ts`).
 *
 * UNDEFINED ON FAILURE, never a guess: the caller decides what an absent reading means.
 */
export async function classifierReading(
  prompt: string,
  opts?: ClassifyIntentOptions & { maxTokens?: number },
): Promise<string | undefined> {
  const modelId = opts?.modelId || CLASSIFIER_MODEL;
  try {
    const startedAt = Date.now();
    const response = await bedrockClient.send(new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: opts?.maxTokens ?? 10, temperature: 0 },
    }));
    const out = response.output?.message?.content?.[0];
    const text = out && 'text' in out && out.text ? out.text : '';
    console.log('[IntentClassifier] reading', {
      modelId, latencyMs: Date.now() - startedAt, reply: text.slice(0, 20),
    });
    return text;
  } catch (error) {
    console.error('[IntentClassifier] reading failed:', error);
    return undefined;
  }
}

/**
 * Keyword-only intent classification (no LLM/Bedrock call). This is the `classifierMode: 'keyword'`
 * path — an opt-in a deployment can select on a cheap profile to skip the per-turn classifier cost.
 * It is NOT tied to any classification: every default profile (basic included) uses the LLM
 * classifier (`classifyIntent`); this runs only when a profile explicitly sets keyword mode.
 */
export function classifyIntentByKeyword(userMessage: string, pack?: IntentPack): IntentClassification {
  // The same fast paths the LLM classifier takes, from the same place: this function held a second
  // copy of both word lists, so a greeting added to one path would silently not be a greeting on the
  // other.
  return fastPathIntent(userMessage) ?? classifyByKeywords(userMessage, pack);
}

/**
 * Fallback keyword-based classification (used on an LLM classifier failure, or by a keyword-mode profile).
 * Domain keywords come from the active intent pack; only greeting/ack are handled by the callers
 * before this point, so here we match domain keywords then default to GENERAL.
 */
function classifyByKeywords(userMessage: string, pack?: IntentPack): IntentClassification {
  const hit = classifyByPackKeywords(userMessage, pack);
  if (hit) return { intent: hit, confidence: 'medium' };
  return { intent: IntentType.GENERAL, confidence: 'low' };
}

/**
 * Map an intent key to its delivery option name. Universal keys are fixed; domain keys read the
 * active intent pack's `delivery` class.
 */
export function intentToDeliveryOption(intent: string): string {
  return deliveryClassForIntent(intent);
}
