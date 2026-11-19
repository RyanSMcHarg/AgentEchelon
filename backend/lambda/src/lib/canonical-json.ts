/**
 * CANONICAL JSON: an object with its keys sorted at every depth and its undefined fields left out, so the same content
 * always serializes to the same bytes. The basis of every content hash a version is identified by: its `configId`
 * (`profileDefinitionConfigId`, active-profile.ts) and the hash of each machine a task starts on (`machineHashOf`,
 * version-machines.ts), so the two can never disagree about what "the same" means.
 */
import { createHash } from 'node:crypto';

/** Recursively key-sort an object or array; undefined fields are dropped. */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = canonicalize(val);
    }
    return out;
  }
  return v;
}

/** A short, stable content hash of a value's canonical JSON: the first 12 hex characters of its SHA-256. */
export function contentHash12(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(v)), 'utf8').digest('hex').slice(0, 12);
}
