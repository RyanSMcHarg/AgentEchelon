import type { PublishedVariables, VariableTrust, VariableType } from '../../../../../../backend/lambda/src/lib/variables.ts';

/**
 * THE VARIABLES PAGE'S GROUPS: what each value describes, read from the source's name. A context source's fields group
 * under that source and take its deployment's own words; every other source's definition is console copy.
 */
export const PLATFORM_GROUPS = ['person', 'conversation', 'origin', 'host', 'event', 'invitation'] as const;
export type PlatformGroup = (typeof PLATFORM_GROUPS)[number];

const GROUP_OF_KIND: Readonly<Record<string, PlatformGroup>> = {
  person: 'person',
  pref: 'person',
  fact: 'person',
  conversation: 'conversation',
  signal: 'conversation',
  participant: 'conversation',
  participantRole: 'conversation',
  host: 'host',
  event: 'event',
  invitation: 'invitation',
};

/** The conversation's fields that say why it exists, written by whatever opened it. */
const ORIGIN_SOURCES: ReadonlySet<string> = new Set([
  'conversation:priorSubject',
  'conversation:priorMessage',
  'conversation:parentRef',
  'conversation:eventSummary',
  'conversation:visitSummary',
]);

export interface VariableRow {
  source: string;
  type: VariableType;
  trust: VariableTrust;
  /** A context source's field: what the deployment's catalog says it holds. */
  description?: string;
}

export interface ContextSourceGroup {
  key: string;
  title: string;
  description?: string;
  rows: VariableRow[];
}

type CatalogSource = { key: string; title?: string; description?: string };

/** The field's source key: `company-docs` for `ctx:company-docs.digest`. */
function contextKeyOf(source: string): string {
  return source.slice('ctx:'.length).split('.')[0];
}

/** One group per context source the classification publishes, in the catalog's order. */
export function contextSourceGroups(published: PublishedVariables | undefined, catalog: readonly CatalogSource[] = []): ContextSourceGroup[] {
  const rows = (published?.sources ?? []).filter((s) => s.source.startsWith('ctx:'));
  const keys = [...new Set(rows.map((s) => contextKeyOf(s.source)))];
  const position = (key: string) => {
    const at = catalog.findIndex((c) => c.key === key);
    return at < 0 ? catalog.length : at;
  };
  return keys.sort((a, b) => position(a) - position(b)).map((key) => {
    const entry = catalog.find((c) => c.key === key);
    return {
      key,
      title: entry?.title ?? key,
      description: entry?.description,
      rows: rows.filter((s) => contextKeyOf(s.source) === key),
    };
  });
}

/** The platform's own values by what each describes. An onboarding answer is listed with the person who gave it. */
export function platformGroups(published: PublishedVariables | undefined): Array<{ id: PlatformGroup; rows: VariableRow[] }> {
  const facts: VariableRow[] = (published?.facts ?? []).map((key) => ({ source: `fact:${key}`, type: 'string', trust: 'member' }));
  const rows: VariableRow[] = [...(published?.sources ?? []).filter((s) => !s.source.startsWith('ctx:')), ...facts];
  const groupOf = (source: string): PlatformGroup => (ORIGIN_SOURCES.has(source) ? 'origin' : GROUP_OF_KIND[source.split(':')[0]] ?? 'conversation');
  return PLATFORM_GROUPS.map((id) => ({ id, rows: rows.filter((r) => groupOf(r.source) === id) })).filter((g) => g.rows.length > 0);
}

/** The locale key and values of a platform source's definition. A role or an onboarding answer names itself. */
export function definitionKey(source: string): { key: string; values?: { name: string } } {
  const [kind, ...rest] = source.split(':');
  const name = rest.join(':');
  if (kind === 'fact' || kind === 'participantRole') return { key: `admin.variables.source.${kind}`, values: { name } };
  return { key: `admin.variables.source.${kind}.${name}` };
}
