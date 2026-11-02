/**
 * Company-context retrieval (shared)
 *
 * Classification-scoped company/product/pricing/FAQ/financial document retrieval from
 * the attachments bucket under `context/{classification}/*`, one prefix per declared classification.
 *
 * **Defense-in-depth is enforced at IAM, not here.** The caller's execution
 * role grants `s3:GetObject` only for the prefixes its classification's `grants` set names. This module
 * walks every prefix the classification is granted and returns whatever it could read; an
 * AccessDenied on a prefix outside the caller's set is the boundary working, and that
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
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { sessionClient } from './assistant-session.js';

const s3 = sessionClient(S3Client, {});

/** An S3 client on an assistant's credentials, for a read the assistant is granted and the shared role is not. */
export function roleContextS3Client(credentials: AwsCredentialIdentity): S3Client {
  return new S3Client({ credentials });
}

/**
 * The `context/{classification}/` prefixes a caller may read, derived from the SAME
 * `grantsFor` resolver the IAM statement generator consumes (registry.contextPrefixesGranted)
 * — NOT a hardcoded classification list. That closes the drift the old `CLASSIFICATION_PREFIXES`
 * const had: a renamed/added classification now moves IAM and retrieval together. Taken in REVERSE of
 * the declared order, which on a prefix-shaped deployment puts the caller's own classification first,
 * so its documents survive the total-chars cap. IAM still enforces every GetObject; this only skips
 * prefixes the caller could not read anyway.
 */
function contextPrefixesFor(classification: string): string[] {
  return defaultProfileRegistry.contextPrefixesGranted(classification, { reversed: true });
}
// Platform self-knowledge (about the AgentEchelon product itself) lives OUTSIDE
// the company `context/` tree so a company/business question never loads it.
// Retrieved separately via loadPlatformInfo (exposed as the load_platform_info
// tool) only when the user asks about the platform.
export const PLATFORM_PREFIX = 'platform-knowledge/';

/**
 * THE PLATFORM PREFIXES A CLASSIFICATION READS: `platform-knowledge/{c}/` for each classification it grants.
 * Platform documentation is internal material; the external classification is granted a
 * public overview only. IAM enforces the same set on the role and the vended session, so this only avoids
 * asking for what would be refused.
 */
export function platformPrefixesFor(classification: string): string[] {
  return [...defaultProfileRegistry.grantsFor(classification)].reverse().map((c) => `${PLATFORM_PREFIX}${c}/`);
}
// Per-doc cap so one huge file can't blow the model's context window.
const MAX_DOC_CHARS = 8_000;
// Total cap so the invoke budget stays bounded.
const MAX_TOTAL_CHARS = 24_000;

export interface CompanyDoc {
  source: string;
  /** The declared classification whose prefix holds the document (`classificationFromKey`). */
  classification: string;
  content: string;
  truncated: boolean;
}

export interface CompanyContextResult {
  documentCount: number;
  classificationsAccessible: Array<CompanyDoc['classification']>;
  documents: CompanyDoc[];
}

/**
 * THE CLASSIFICATION A DOCUMENT'S KEY FILES IT UNDER: the segment after `context/` or `platform-knowledge/`,
 * when it names a classification this deployment declares (an alias reads as the classification it names).
 * `undefined` for any other key, and such a document is not loaded: content under a prefix no declared
 * classification names has no classification to be read at.
 */
export function classificationFromKey(key: string): string | undefined {
  for (const root of ['context/', PLATFORM_PREFIX]) {
    if (!key.startsWith(root)) continue;
    const [segment, ...rest] = key.slice(root.length).split('/');
    return segment && rest.join('/') ? defaultProfileRegistry.resolveClassification(segment) : undefined;
  }
  return undefined;
}

function isAccessDenied(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  return name === 'AccessDenied' || name === 'AccessDeniedException';
}

async function listAccessibleKeys(bucket: string, prefixes: string[], client: S3Client = s3): Promise<string[]> {
  const keys: string[] = [];
  for (const Prefix of prefixes) {
    try {
      const resp = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix }));
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

async function fetchDoc(bucket: string, key: string, client: S3Client = s3): Promise<CompanyDoc | null> {
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await resp.Body?.transformToString('utf-8');
    if (!body) return null;
    const truncated = body.length > MAX_DOC_CHARS;
    const content = truncated
      ? body.slice(0, MAX_DOC_CHARS) + '\n[truncated — document exceeds per-doc cap]'
      : body;
    const classification = classificationFromKey(key);
    if (!classification) {
      console.warn(`[company-context] ${key} is under no declared classification's prefix; not loaded`);
      return null;
    }
    return { source: key, classification, content, truncated };
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
  docFilter?: Set<string>,
  client: S3Client = s3,
): Promise<CompanyContextResult> {
  const allKeys = await listAccessibleKeys(bucket, prefixes, client);
  // SELECTIVE load (GUIDE-ASSISTANT-CONTEXT): when the model named the document(s) it needs (by filename,
  // from the digest), fetch ONLY those instead of the whole corpus — the cost win. An empty/unmatched
  // filter falls through to loading everything (recall-safe: a broad question still gets the full set).
  const filtered = docFilter && docFilter.size
    ? allKeys.filter((k) => docFilter.has(k.split('/').pop() || ''))
    : [];
  const keys = filtered.length ? filtered : allKeys;
  const docs: CompanyDoc[] = [];
  let totalChars = 0;
  for (const key of keys) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      console.log(`[${logLabel}] total-chars cap reached at ${docs.length} docs`);
      break;
    }
    const doc = await fetchDoc(bucket, key, client);
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
export async function loadCompanyContext(
  bucket: string,
  classification: string,
  opts?: {
    documents?: string[];
    /**
     * THE ROLE'S OWN PREFIXES and THE ASSISTANT'S CREDENTIALS (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION Phase 1b).
     * The live processor always passes both: the shared Lambda role holds no `context/` grant, so a read
     * without the assistant's credentials is refused by IAM. Absent, the classification's prefixes on the ambient client.
     */
    prefixes?: string[];
    credentials?: AwsCredentialIdentity;
  },
): Promise<CompanyContextResult> {
  // The model names the specific documents it needs (filenames from the digest). Only those are fetched —
  // scoping ingestion to the task instead of dumping every doc each turn. No selection ⇒ load-all (bounded).
  const docFilter = opts?.documents?.length
    ? new Set(opts.documents.map((d) => d.split('/').pop() || d))
    : undefined;
  // Cache per (bucket, classification, doc set): different classifications resolve different prefix sets.
  const prefixes = opts?.prefixes ?? contextPrefixesFor(classification);
  // KEYED ON THE PREFIX SET, not the classification: two roles of one classification read different
  // context, and a cache keyed on the classification would serve one role's documents to the other.
  const cacheKey = `${bucket}::${prefixes.join('|')}::${docFilter ? [...docFilter].sort().join(',') : 'ALL'}`;
  const cached = companyContextCache.get(cacheKey);
  if (cached && Date.now() - cached.at < COMPANY_CONTEXT_CACHE_TTL_MS) return cached.result;
  const client = opts?.credentials ? roleContextS3Client(opts.credentials) : s3;
  const result = await loadDocsFromPrefixes(bucket, prefixes, 'company-context', docFilter, client);
  companyContextCache.set(cacheKey, { result, at: Date.now() });
  return result;
}

/**
 * Load the AgentEchelon platform self-knowledge (`platform-knowledge/*`) — what
 * the platform is, its architecture and capabilities. Exposed as the
 * `load_platform_info` tool and called ONLY when the user asks about the
 * platform itself, not for company/business questions.
 */
export async function loadPlatformInfo(
  bucket: string,
  classification: string,
  opts?: { credentials?: AwsCredentialIdentity },
): Promise<CompanyContextResult> {
  const client = opts?.credentials ? roleContextS3Client(opts.credentials) : s3;
  return loadDocsFromPrefixes(bucket, platformPrefixesFor(classification), 'platform-info', undefined, client);
}

// ---------------------------------------------------------------------------
// Company-context DIGEST (ADR-017). A small, always-present per-classification manifest of
// the company documents the classification may read (title + one-line description). It
// tells the assistant WHAT company context exists so it can fetch the right
// document (via load_company_context) or rely on the deterministic router
// retrieval, rather than guessing or dumping the whole corpus. The digest is
// precomputed at seed/ingestion time and stored at `context/{classification}/_digest.json`
// (cumulative: it lists every document the classification's grants reach); the caller reads only its own
// classification's file, so the IAM prefix boundary scopes the digest exactly like the
// documents it describes.
// ---------------------------------------------------------------------------

export interface DigestEntry {
  /** The document's FILENAME (e.g. "financial-data.json") — the stable id the model names in the
   *  load_company_context `documents` arg to fetch this doc specifically. Absent on legacy digests ⇒ the
   *  tool falls back to loading all docs (recall-safe). */
  file?: string;
  /** Human-readable document title, e.g. "Financial data". */
  title: string;
  /** One-line description of what the document contains. */
  description: string;
  /** The declared classification that owns the document. */
  classification: string;
}

/** Warm-container cache: the digest is static per deployment, so read it once
 *  per classification and reuse it, rather than re-fetching from S3 every turn. */
const digestCache = new Map<string, DigestEntry[]>();
/** The role-scoped digests, keyed on the prefix set (see `loadContextDigest`). */
const roleDigestCache = new Map<string, DigestEntry[]>();

/** Load the caller classification's context digest (`context/{classification}/_digest.json`).
 *  Returns [] if none is present (older seed, or no company docs). Cached warm. */
export async function loadContextDigest(
  bucket: string,
  classification: string,
  opts?: { prefixes?: string[]; credentials?: AwsCredentialIdentity },
): Promise<DigestEntry[]> {
  // A ROLE'S DIGEST is the union of the digests under its own prefixes, read on its assistant's credentials. Each
  // classification's digest lists only what that classification may read, so the union lists exactly the
  // documents the role may read and none it may not (a prefix outside the role's set never reaches its digest).
  if (opts?.prefixes) {
    const key = `${bucket}::${opts.prefixes.join('|')}`;
    const hit = roleDigestCache.get(key);
    if (hit) return hit;
    const client = opts.credentials ? roleContextS3Client(opts.credentials) : s3;
    const seen = new Set<string>();
    const union: DigestEntry[] = [];
    for (const prefix of opts.prefixes) {
      try {
        const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}_digest.json` }));
        const body = await resp.Body?.transformToString('utf-8');
        const entries = body ? (JSON.parse(body) as DigestEntry[]) : [];
        for (const e of Array.isArray(entries) ? entries : []) {
          const id = e.file || e.title;
          if (!seen.has(id)) { seen.add(id); union.push(e); }
        }
      } catch (err: unknown) {
        if (!isAccessDenied(err) && (err as { name?: string }).name !== 'NoSuchKey') {
          console.warn(`[company-context] digest load failed for ${prefix}_digest.json:`, err);
        }
      }
    }
    roleDigestCache.set(key, union);
    return union;
  }
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
  // Show the FILENAME so the model can request exactly the doc(s) it needs.
  const lines = entries.map((e) => (e.file ? `- ${e.file} — ${e.title}: ${e.description}` : `- ${e.title}: ${e.description}`)).join('\n');
  return (
    '\n\n## AVAILABLE COMPANY CONTEXT\n' +
    'These company documents are available to you for this conversation. When a question needs specifics '
    + 'from one, call load_company_context with the `documents` list set to ONLY the filename(s) you need '
    + '(shown at the start of each line below) — do not request documents you do not need. Relevant details '
    + 'are also folded in automatically when available.\n' +
    lines
  );
}

/** Clear the warm digest cache (test hook). */
export function __clearDigestCache(): void {
  digestCache.clear();
}
