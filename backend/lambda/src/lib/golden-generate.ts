/**
 * ENTRIES GENERATED FROM THE DRAFT'S INTENT PACK (ADR-065 decision 8, SPEC-EVALUATION FR30).
 *
 * A new assistant or a new intent has no traffic to label and may have no file to upload. The classification's utility
 * model writes requests for each intent from what the intent says it covers: its description, its summary and its
 * keywords. A generated request is about no person and still passes through the detector before it is stored, and it
 * enters as capability, marked generated: it becomes regression only after the active version passes it and a person
 * promotes it, so a request the model wrote never refuses a draft by itself. Pure, so the prompt and the reading of the
 * model's answer are pinned by unit tests.
 */
import type { IntentDef } from './intent-pack.js';

/** Requests per intent: the default, and the most one call asks for. */
export const GENERATE_PER_INTENT_DEFAULT = 3;
export const GENERATE_PER_INTENT_MAX = 5;
/** Intents one call generates for: each is a model call inside the request's time. */
export const GENERATE_MAX_INTENTS = 12;
/** The longest request kept; a longer one is not what a person types. */
export const GENERATED_REQUEST_MAX = 1000;

/** What a generation is told about one intent: the pack's own words, nothing about a person. */
export type GenerationIntent = Pick<IntentDef, 'key' | 'description'> & { summary?: string; keywords?: string[] };

export function generationIntentOf(def: IntentDef): GenerationIntent {
  return {
    key: def.key,
    description: def.description,
    ...(def.summary ? { summary: def.summary } : {}),
    ...(def.keywords?.length ? { keywords: def.keywords } : {}),
  };
}

/** The prompt for one intent's requests. */
export function generationPrompt(intent: GenerationIntent, count: number): string {
  return [
    `Write ${count} different requests a person at a company might send to an assistant, each one a case of the intent below.`,
    'Vary the wording, the length and the detail, the way different people ask. Each request stands alone as the first message of a conversation.',
    'Do not use any real or realistic personal details: no names of people, email addresses, phone numbers, addresses or account numbers.',
    'Answer with only a JSON array of strings, one request each, and nothing else.',
    '',
    `Intent: ${intent.key}`,
    `When it applies: ${intent.description}`,
    ...(intent.summary ? [`What the person gets: ${intent.summary}`] : []),
    ...(intent.keywords?.length ? [`Words people use: ${intent.keywords.join(', ')}`] : []),
  ].join('\n');
}

/**
 * The requests in the model's answer: the first JSON array of strings in it, trimmed, each kept once, none empty or past
 * the length a person types, at most `count`. Null when the answer holds no such array, so a failed generation is named
 * rather than stored as nothing.
 */
export function requestsFromAnswer(answer: string, count: number): string[] | null {
  const parsed = firstStringArray(answer);
  if (!parsed) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of parsed) {
    if (typeof r !== 'string') continue;
    const text = r.trim();
    const key = text.toLowerCase();
    if (!text || text.length > GENERATED_REQUEST_MAX || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === count) break;
  }
  return out.length ? out : null;
}

/**
 * The first balanced `[ ... ]` in the text that parses as a JSON array holding a string, scanning brackets outside string
 * literals, so a note after the array ("placeholders like [name] were avoided") does not join it.
 */
function firstStringArray(text: string): unknown[] | null {
  for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(parsed) && parsed.some((r) => typeof r === 'string')) return parsed;
        } catch {
          // Not JSON from this bracket; try the next one.
        }
        break;
      }
    }
  }
  return null;
}
