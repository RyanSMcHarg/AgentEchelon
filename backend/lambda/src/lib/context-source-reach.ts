/**
 * WHICH CATALOG SOURCES AN ASSISTANT'S ROLE CAN READ, as one rule the turn, the validator and the console share.
 *
 * A catalog `s3-prefix` source under `context/` is company context: the same documents `load_company_context` reads,
 * read on the assistant's own credentials, which IAM scopes to its role's prefixes (`contextPrefixesForRole`). Such
 * a source is readable only when one of the role's prefixes covers it. Every other source is read on the shared
 * processor role and is not narrowed by the assistant's role.
 *
 * No imports, so the console can import it beside the catalog it reads.
 */

/** The fields of a published catalog entry this rule reads. */
export interface SourceReach {
  type?: string;
  prefix?: string;
}

/** Whether the entry is company context: an `s3-prefix` source under `context/`. */
export function isCompanyContextSource(entry: SourceReach): boolean {
  return entry.type === 's3-prefix' && (entry.prefix || '').startsWith('context/');
}

/**
 * Whether an assistant whose role reads `rolePrefixes` can read the entry. A company-context source is readable when
 * one of the prefixes covers its own; any other source is readable whatever the role.
 */
export function readableByRole(entry: SourceReach, rolePrefixes: readonly string[]): boolean {
  if (!isCompanyContextSource(entry)) return true;
  const prefix = entry.prefix || '';
  return rolePrefixes.some((p) => prefix.startsWith(p));
}
