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
} from './intent-pack.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

// Haiku for fast, cheap classification
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';

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
}

/** Options for {@link classifyIntent}. */
export interface ClassifyIntentOptions {
  /**
   * Override the classifier model id (a classification A/B experiment's variant
   * model). Absent ⇒ the deployment default CLASSIFIER_MODEL.
   */
  modelId?: string;
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
  // Fast path: empty or very short messages are greetings
  const message = userMessage.trim().toLowerCase();
  if (!message || message.length < 3) {
    return { intent: IntentType.GREETING, confidence: 'high' };
  }

  // Fast path: exact match greetings (no LLM call needed)
  const exactGreetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'];
  if (exactGreetings.includes(message)) {
    return { intent: IntentType.GREETING, confidence: 'high' };
  }

  // Fast path: exact match acknowledgments
  const exactAcknowledgments = ['thanks', 'thank you', 'ok', 'okay', 'got it', 'great', 'perfect', 'cool', 'bye', 'goodbye'];
  if (exactAcknowledgments.includes(message)) {
    return { intent: IntentType.ACKNOWLEDGMENT, confidence: 'high' };
  }

  // Use LLM for more complex classification. Categories come from the active intent pack —
  // the universal three plus the deployment's domain intents — so a deployment with a domain pack
  // classifies "pull the Q3 numbers from this sheet" as `data_extraction`, not the generic `GENERAL`.
  try {
    const pack = getIntentPack();
    const classificationPrompt = `Classify the following user message into one of these intent categories. Return ONLY the category name, nothing else.

Categories:
- GREETING: ONLY pure greetings with no question or topic — "hi", "hello", "hey there". If the message contains ANY question, request, or topic beyond the greeting, classify as GENERAL instead.
- ACKNOWLEDGMENT: Thanks, goodbye, confirmations like "ok", "got it", "bye"
${intentPackCategoryLines(pack)}
- GENERAL: General questions, requests, or other inquiries that don't fit the above categories

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
    else if (key === 'acknowledgment') { intent = IntentType.ACKNOWLEDGMENT; confidence = 'high'; }
    else if (key === 'general') { intent = IntentType.GENERAL; confidence = 'medium'; }
    else if (knownIntentKeys(pack).has(key)) { intent = key; confidence = 'high'; }
    return { intent, confidence, ...instrumentation };
  } catch (error) {
    console.error('[IntentClassifier] LLM classification failed:', error);
    return classifyByKeywords(userMessage);
  }
}

/**
 * Keyword-only classification for Basic tier (no LLM call to save cost)
 */
export function classifyIntentBasic(userMessage: string): IntentClassification {
  const message = userMessage.trim().toLowerCase();

  if (!message || message.length < 3) {
    return { intent: IntentType.GREETING, confidence: 'high' };
  }

  const exactGreetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'];
  if (exactGreetings.includes(message)) {
    return { intent: IntentType.GREETING, confidence: 'high' };
  }

  const exactAcknowledgments = ['thanks', 'thank you', 'ok', 'okay', 'got it', 'great', 'perfect', 'cool', 'bye', 'goodbye'];
  if (exactAcknowledgments.includes(message)) {
    return { intent: IntentType.ACKNOWLEDGMENT, confidence: 'high' };
  }

  return classifyByKeywords(userMessage);
}

/**
 * Fallback keyword-based classification (LLM failure or Basic tier).
 * Domain keywords come from the active intent pack; only greeting/ack are handled by the callers
 * before this point, so here we match domain keywords then default to GENERAL.
 */
function classifyByKeywords(userMessage: string): IntentClassification {
  const hit = classifyByPackKeywords(userMessage);
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
