/**
 * Company-context retrieval (shared)
 *
 * Classification-scoped company/product/pricing/FAQ/financial document retrieval from
 * the attachments bucket under `context/{basic,standard,premium}/*`.
 *
 * **Defense-in-depth is enforced at IAM, not here.** The caller's execution
 * role grants `s3:GetObject` only for the prefixes its classification may read (basic →
 * context/basic/*; standard → +standard; premium → all three). This module
 * walks every known prefix and returns whatever it could read — an
 * AccessDenied on a higher classification's prefix is the boundary working, and that
 * document is silently omitted.
 *
 * Used by both the Bedrock-Agent action-group Lambda
 * (`action-groups/load-company-context.ts`) and the Converse tool loop
 * (`async-processor-core.ts`, ADR-011). Whichever role is attached
 * to the running Lambda decides what is visible.
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

const s3 = new S3Client({});

// Every known classification prefix, MOST-SPECIFIC-FIRST (premium → standard → basic) so
// that if the total-chars cap is ever hit, the caller's OWN classification documents load
// first and survive rather than being dropped last. IAM decides which are
// readable; a lower-clearance caller simply gets AccessDenied on the higher prefixes.
export const CLASSIFICATION_PREFIXES = ['context/premium/', 'context/standard/', 'context/basic/'];
// Platform self-knowledge (about the AgentEchelon product itself) lives OUTSIDE
// the company `context/` tree so a company/business question never loads it.
// Retrieved separately via loadPlatformInfo (exposed as the load_platform_info
// tool) only when the user asks about the platform.
export const PLATFORM_PREFIX = 'platform-knowledge/';
// Per-doc cap so one huge file can't blow the model's context window.
const MAX_DOC_CHARS = 8_000;
// Total cap so the invoke budget stays bounded.
const MAX_TOTAL_CHARS = 24_000;

export interface CompanyDoc {
  source: string;
  classification: 'basic' | 'standard' | 'premium' | 'unknown';
  content: string;
  truncated: boolean;
}

export interface CompanyContextResult {
  documentCount: number;
  classificationsAccessible: Array<CompanyDoc['classification']>;
  documents: CompanyDoc[];
}

function classificationFromKey(key: string): CompanyDoc['classification'] {
  if (key.startsWith('context/basic/')) return 'basic';
  if (key.startsWith('context/standard/')) return 'standard';
  if (key.startsWith('context/premium/')) return 'premium';
  return 'unknown';
}

function isAccessDenied(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  return name === 'AccessDenied' || name === 'AccessDeniedException';
}

async function listAccessibleKeys(bucket: string, prefixes: string[]): Promise<string[]> {
  const keys: string[] = [];
  for (const Prefix of prefixes) {
    try {
      const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix }));
      for (const obj of resp.Contents || []) {
        // Skip `_`-prefixed files (e.g. `_digest.json`, the per-classification context
        // digest). They are metadata about the corpus, not corpus documents, so
        // they must not be loaded as company content.
        if (obj.Key && !(obj.Key.split('/').pop() || '').startsWith('_')) keys.push(obj.Key);
      }
    } catch (err: unknown) {
      // AccessDenied on a prefix this clearance shouldn't see is the boundary
      // working — log and continue. Other errors: warn and continue.
      if (isAccessDenied(err)) {
        console.log(`[company-context] classification scope: ${Prefix} not accessible (expected for lower clearances)`);
        continue;
      }
      console.warn(`[company-context] ListObjectsV2 failed for ${Prefix}:`, err);
    }
  }
  return keys;
}

async function fetchDoc(bucket: string, key: string): Promise<CompanyDoc | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await resp.Body?.transformToString('utf-8');
    if (!body) return null;
    const truncated = body.length > MAX_DOC_CHARS;
    const content = truncated
      ? body.slice(0, MAX_DOC_CHARS) + '\n[truncated — document exceeds per-doc cap]'
      : body;
    return { source: key, classification: classificationFromKey(key), content, truncated };
  } catch (err: unknown) {
    if (isAccessDenied(err)) return null; // boundary in action
    console.warn(`[company-context] GetObject failed for ${key}:`, err);
    return null;
  }
}

/**
 * Load every readable document under the given prefixes into a flat, capped
 * list (per-doc + total char caps). Shared by the company-context and
 * platform-info loaders — the caller decides how to present the result.
 */
async function loadDocsFromPrefixes(
  bucket: string,
  prefixes: string[],
  logLabel: string,
): Promise<CompanyContextResult> {
  const keys = await listAccessibleKeys(bucket, prefixes);
  const docs: CompanyDoc[] = [];
  let totalChars = 0;
  for (const key of keys) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      console.log(`[${logLabel}] total-chars cap reached at ${docs.length} docs`);
      break;
    }
    const doc = await fetchDoc(bucket, key);
    if (!doc) continue;
    docs.push(doc);
    totalChars += doc.content.length;
  }
  return {
    documentCount: docs.length,
    classificationsAccessible: Array.from(new Set(docs.map((d) => d.classification))),
    documents: docs,
  };
}

// Warm result cache — company docs are static (they change only on seed/ingest),
// so re-Listing + Getting S3 on every tool call/turn is wasted work
// (docs/GUIDE-ASSISTANT-CONTEXT.md: "do not re-gather unchanged context"). Cache the
// result per bucket for the Lambda's warm life; the IAM classification is fixed per Lambda
// instance, so the readable document set is stable for that instance.
const companyContextCache = new Map<string, { result: CompanyContextResult; at: number }>();
const COMPANY_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Test hook: clear the warm company-context cache. */
export function __clearCompanyContextCache(): void {
  companyContextCache.clear();
}

/**
 * Load every company/business document the caller's IAM role can read
 * (`context/{classification}/*`). Does NOT include platform self-knowledge — that is a
 * separate retrieval (loadPlatformInfo), so a company question never spends the
 * budget on AgentEchelon platform docs. Result is warm-cached per bucket
 * (COMPANY_CONTEXT_CACHE_TTL_MS) so the same classification context is not re-fetched from
 * S3 every turn.
 */
export async function loadCompanyContext(bucket: string): Promise<CompanyContextResult> {
  const cached = companyContextCache.get(bucket);
  if (cached && Date.now() - cached.at < COMPANY_CONTEXT_CACHE_TTL_MS) return cached.result;
  const result = await loadDocsFromPrefixes(bucket, CLASSIFICATION_PREFIXES, 'company-context');
  companyContextCache.set(bucket, { result, at: Date.now() });
  return result;
}

/**
 * Load the AgentEchelon platform self-knowledge (`platform-knowledge/*`) — what
 * the platform is, its architecture and capabilities. Exposed as the
 * `load_platform_info` tool and called ONLY when the user asks about the
 * platform itself, not for company/business questions.
 */
export async function loadPlatformInfo(bucket: string): Promise<CompanyContextResult> {
  return loadDocsFromPrefixes(bucket, [PLATFORM_PREFIX], 'platform-info');
}

// ---------------------------------------------------------------------------
// Company-context DIGEST (ADR-017). A small, always-present per-classification manifest of
// the company documents the classification may read (title + one-line description). It
// tells the assistant WHAT company context exists so it can fetch the right
// document (via load_company_context) or rely on the deterministic router
// retrieval, rather than guessing or dumping the whole corpus. The digest is
// precomputed at seed/ingestion time and stored at `context/{classification}/_digest.json`
// (cumulative: premium includes standard + basic); the caller reads only its own
// classification's file, so the IAM prefix boundary scopes the digest exactly like the
// documents it describes.
// ---------------------------------------------------------------------------

export interface DigestEntry {
  /** Human-readable document title, e.g. "Financial data". */
  title: string;
  /** One-line description of what the document contains. */
  description: string;
  /** The classification that owns the document (basic|standard|premium). */
  classification: 'basic' | 'standard' | 'premium';
}

/** Warm-container cache: the digest is static per deployment, so read it once
 *  per classification and reuse it, rather than re-fetching from S3 every turn. */
const digestCache = new Map<string, DigestEntry[]>();

/** Load the caller classification's context digest (`context/{classification}/_digest.json`).
 *  Returns [] if none is present (older seed, or no company docs). Cached warm. */
export async function loadContextDigest(
  bucket: string,
  classification: 'basic' | 'standard' | 'premium',
): Promise<DigestEntry[]> {
  const cached = digestCache.get(classification);
  if (cached) return cached;
  const key = `context/${classification}/_digest.json`;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await resp.Body?.transformToString('utf-8');
    const entries = body ? (JSON.parse(body) as DigestEntry[]) : [];
    const valid = Array.isArray(entries) ? entries : [];
    digestCache.set(classification, valid);
    return valid;
  } catch (err: unknown) {
    if (!isAccessDenied(err)) {
      console.warn(`[company-context] digest load failed for ${key}:`, err);
    }
    digestCache.set(classification, []);
    return [];
  }
}

/** Render the digest as an always-present system-prompt section. Empty string
 *  when there is no digest, so callers can append unconditionally. */
export function buildDigestHint(entries: DigestEntry[]): string {
  if (!entries.length) return '';
  const lines = entries.map((e) => `- ${e.title}: ${e.description}`).join('\n');
  return (
    '\n\n## AVAILABLE COMPANY CONTEXT\n' +
    'These company documents are available to you for this conversation. When a '
    + 'question needs specifics from one, retrieve it (the load_company_context '
    + 'tool) rather than guessing; relevant details are also folded in '
    + 'automatically when available.\n' +
    lines
  );
}

/** Clear the warm digest cache (test hook). */
export function __clearDigestCache(): void {
  digestCache.clear();
}
