/**
 * ONE Titan embedding call, for every consumer of the 1024-dim conversation vector space.
 *
 * ADR-002 picks Titan v2 at 1024 dimensions, and ADR-004 makes document and conversation embeddings
 * share that space. Three call sites needed the same request and had grown two byte-identical
 * private copies - `drift-detection`'s `embedText` and `embedding-writer`'s `embed` - differing only
 * in their timeout. A third copy was about to be written for the cross-conversation lookup
 * (ADR-004 surface 3), which is the point at which one implementation stops being a preference.
 *
 * THE TIMEOUT IS THE PARAMETER, because it is the one thing the callers legitimately disagree about
 * and the disagreement is documented: the live turn path cannot wait (a drift check runs inside
 * someone's turn), while the summary writer is asynchronous and can. Folding them to one number
 * would either stall a turn or give the writer a failure rate it has no reason to carry.
 *
 * Returns `null` rather than throwing on any failure, and every caller treats null as "no embedding
 * available" and degrades to its own fallback. A best-effort side path never blocks a reply
 * (tenet D5), and an embedding is exactly that: a better answer when it arrives, never a gate.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/** Titan v2, per ADR-002. The env override exists so a deployment can pin a different revision. */
export const EMBEDDING_MODEL_ID =
  process.env.DRIFT_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';

/** 1024, per ADR-002. `summary_embeddings.embedding` is `vector(1024)`; a mismatch is rejected. */
export const EMBEDDING_DIM = 1024;

/** The live turn path: a drift check and a related-conversation lookup both run inside a turn. */
export const EMBEDDING_TIMEOUT_LIVE_MS = 500;

/** The asynchronous summary writer, which nobody is waiting on. */
export const EMBEDDING_TIMEOUT_ASYNC_MS = 5000;

const bedrockClient = new BedrockRuntimeClient({});

export interface EmbedTextOptions {
  /** How long to wait before abandoning the call. Use one of the two exported constants. */
  timeoutMs: number;
  /** Prefix for the one warning line a failure emits. Omit to stay silent. */
  label?: string;
}

/**
 * The embedding of `text`, or `null` if it could not be produced in time.
 *
 * Truncated to 8,000 characters: Titan v2 accepts far more, and nothing here needs it - a chat
 * message or a conversation summary is nowhere near that, so the cap only bounds a pathological
 * input rather than shaping a normal one.
 *
 * A dimension mismatch returns null rather than the vector. Writing a wrong-width vector would be
 * refused by the column, and comparing one would silently rank against a different space.
 */
export async function embedText(
  text: string,
  options: EmbedTextOptions,
): Promise<number[] | null> {
  const input = text.slice(0, 8000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: EMBEDDING_MODEL_ID,
        body: JSON.stringify({ inputText: input, dimensions: EMBEDDING_DIM, normalize: true }),
        contentType: 'application/json',
        accept: 'application/json',
      }),
      { abortSignal: controller.signal },
    );
    clearTimeout(timer);

    const body = JSON.parse(new TextDecoder().decode(response.body));
    const embedding = body?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
      return null;
    }
    return embedding as number[];
  } catch (err) {
    clearTimeout(timer);
    if (options.label) console.warn(`[${options.label}] Titan call failed:`, err);
    return null;
  }
}

/**
 * A pgvector literal for a vector parameter: `[0.1,0.2,...]`.
 *
 * Kept beside the embedding call because every consumer that compares one needs it, and the format
 * is the driver's requirement rather than any caller's choice.
 */
export function toPgVector(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}
