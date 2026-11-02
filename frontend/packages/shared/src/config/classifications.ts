/**
 * THE DEPLOYMENT'S CLASSIFICATIONS, AS ITS CLIENTS RENDER THEM.
 *
 * A deployment declares its own set (`profiles` in `backend/deploy.config.json`), so no client lists
 * classification names. Each classification's stack publishes its row of the runtime registry, and the person
 * API answers `GET /classifications` from those rows (`clientClassifications`, `backend/lib/config/profiles.ts`):
 * a signed-in app loads the set from it (`loadDeploymentClassifications`), so a classification added later
 * renders with no frontend build.
 *
 * THE BUILD-TIME FALLBACK. The chat app renders before sign-in (the registration screen offers the member
 * classifications as the requested tier), when no person route can be called, so its build also carries the set
 * in `VITE_CLASSIFICATIONS` (`backend/scripts/gen-frontend-env.mjs`, read from the same registry rows,
 * URI-encoded behind `uri:`). It is what the app renders until the signed-in load answers, and what it keeps
 * when that load fails. The admin console renders nothing before sign-in and carries none. Each classification
 * carries:
 *
 *  - `displayName`, what a person reads (authored per deployment, in its language);
 *  - `audience`, `members` (the deployment's own people) or `outside` (a guest or a customer), which the
 *    conversation header shows and the composer's placeholder follows;
 *  - `badgeToken`, one of the design system's categorical palette (`--cls-1` to `--cls-8`), so a badge's
 *    color comes from the definition and never from the name, and no color reads as higher;
 *  - `grants`, what a person holding it reaches, which decides the conversations the New conversation
 *    picker offers (an affordance: the server refuses a creation the person is not cleared for).
 *
 * DISPLAY ONLY. Nothing here decides access; the channel's immutable classification tag does, in IAM.
 * A value this list does not hold is shown as itself, with a neutral badge and the `members` audience.
 */
import type { CSSProperties } from 'react';
import { personUrl } from '../platform/config';

export type BadgeToken = `cls-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export type Audience = 'members' | 'outside';

export interface ClientClassification {
  value: string;
  displayName: string;
  audience: Audience;
  badgeToken: BadgeToken;
  grants: string[];
  /** A conversation is held at it (it deploys an assistant). */
  conversational: boolean;
  /** The models it selects from the instance's catalog, and its default (the platform allows, it selects). */
  models?: { selected: string[]; default: string };
  adminPlane?: true;
}

const BADGE = /^cls-[1-8]$/;

function decode(raw: string): string {
  return raw.startsWith('uri:') ? decodeURIComponent(raw.slice(4)) : raw;
}

/** The set a `VITE_CLASSIFICATIONS` value carries; an unreadable value is an empty set, never a guess. */
export function parseClassifications(raw: unknown): ClientClassification[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(text));
  } catch {
    console.warn('[classifications] VITE_CLASSIFICATIONS is not readable; every classification renders as its value');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((c): ClientClassification[] => {
    if (!c || typeof c !== 'object' || typeof (c as { value?: unknown }).value !== 'string') return [];
    const r = c as Record<string, unknown>;
    return [{
      value: String(r.value),
      displayName: typeof r.displayName === 'string' && r.displayName ? r.displayName : String(r.value),
      audience: r.audience === 'outside' ? 'outside' : 'members',
      badgeToken: typeof r.badgeToken === 'string' && BADGE.test(r.badgeToken) ? (r.badgeToken as BadgeToken) : 'cls-1',
      grants: Array.isArray(r.grants) ? r.grants.map(String) : [String(r.value)],
      conversational: r.conversational === true,
      ...(r.models && typeof r.models === 'object' && Array.isArray((r.models as { selected?: unknown }).selected)
        && typeof (r.models as { default?: unknown }).default === 'string'
        ? { models: { selected: ((r.models as { selected: unknown[] }).selected).map(String), default: String((r.models as { default: string }).default) } }
        : {}),
      ...(r.adminPlane === true ? { adminPlane: true as const } : {}),
    }];
  });
}

let installed: ClientClassification[] | null = null;
const listeners = new Set<() => void>();

/**
 * The deployment's set: the one the signed-in load installed, or until then the build's fallback, read once from
 * `VITE_CLASSIFICATIONS` (empty where the build carries none).
 */
export function deploymentClassifications(): ClientClassification[] {
  installed ??= parseClassifications(import.meta.env.VITE_CLASSIFICATIONS);
  return installed;
}

function install(set: ClientClassification[] | null): void {
  installed = set;
  for (const listener of [...listeners]) listener();
}

/** Install a set in place of the build's: a test rendering a custom set. `null` reads the build's again. */
export function setClassificationsForTest(set: ClientClassification[] | null): void {
  install(set);
}

/** Called whenever a new set is installed; returns the unsubscribe. */
export function subscribeClassifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * LOAD THE DEPLOYMENT'S SET FROM `GET /classifications` AND INSTALL IT, as the person whose `idToken` this is.
 * Resolves true when the set was installed, and false when the route could not be read, in which case the set
 * already installed (the build's fallback, or an earlier load) stays: an unreadable answer is never a guess.
 */
export async function loadDeploymentClassifications(idToken: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(personUrl('/classifications'), { headers: { Authorization: `Bearer ${idToken}` } });
    if (!response.ok) {
      console.warn('[classifications] GET /classifications failed:', response.status);
      return false;
    }
    const body = (await response.json()) as { classifications?: unknown };
    if (!Array.isArray(body.classifications)) return false;
    install(parseClassifications(JSON.stringify(body.classifications)));
    return true;
  } catch (err) {
    console.warn('[classifications] GET /classifications failed:', err);
    return false;
  }
}

/** The declared classification a value names, or undefined. */
export function classificationOf(value: string | null | undefined): ClientClassification | undefined {
  if (!value) return undefined;
  return deploymentClassifications().find((c) => c.value === value);
}

/** Whether a value is a classification this deployment declares. */
export function isDeclaredClassification(value: unknown): value is string {
  return typeof value === 'string' && !!classificationOf(value);
}

/** What a person reads for a classification: its declared display name, or the value itself. */
export function classificationName(value: string): string {
  return classificationOf(value)?.displayName ?? value;
}

/** Who a conversation at this classification is for. An undeclared value is `members`. */
export function classificationAudience(value: string | null | undefined): Audience {
  return classificationOf(value)?.audience ?? 'members';
}

/**
 * The badge's colors, as the two custom properties `.cls-badge` reads (`--cls-fg`, `--cls-bg`), from the
 * classification's declared token. An undeclared value gets the neutral pair.
 */
export function classificationBadgeStyle(value: string | null | undefined): CSSProperties {
  const token = classificationOf(value)?.badgeToken;
  return (token
    ? { '--cls-fg': `var(--${token})`, '--cls-bg': `var(--${token}-bg)` }
    : { '--cls-fg': 'var(--text-tertiary)', '--cls-bg': 'var(--surface-100)' }) as CSSProperties;
}

/**
 * THE CONVERSATIONAL CLASSIFICATIONS OF THE DEPLOYMENT'S OWN PEOPLE, in declaration order: what an operator
 * form offers when it targets a classification (an experiment, a classifier replay). Never the admin plane and
 * never an outside classification.
 */
export function memberConversationalClassifications(): ClientClassification[] {
  return deploymentClassifications().filter((c) => c.conversational && c.audience === 'members' && !c.adminPlane);
}

/**
 * The classifications a person holding `holder` may open a conversation at, in declaration order: the
 * conversational, members-audience ones the holder's grants name. An outside conversation (a guest's, a
 * customer's) is opened by its own path, never from the picker. Undeclared or absent: none.
 */
export function creatableClassifications(holder: string | null | undefined): ClientClassification[] {
  const held = classificationOf(holder);
  if (!held) return [];
  const reach = new Set(held.grants);
  return memberConversationalClassifications().filter((c) => reach.has(c.value));
}
