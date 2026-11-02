/**
 * A signed-in person's own language (ADR-062 decision 4): `GET` and `POST /me/language` on the person API
 * (`backend/lambda/src/language-preference-api.ts`). The choice is among the languages the deployment declares, which
 * the server lists, and is the language a message addressed to this person is said in. The person is the caller the
 * edge authorizer resolved, so there is no parameter naming whose language this is.
 *
 * Served in the core of every deployment.
 */
import { personUrl } from '@ae/shared';

/** One language the person may choose: its tag, its English name and its own name. */
export interface LanguageOption {
  tag: string;
  name: string;
  native: string;
}

export interface LanguagePreferenceView {
  /** The chosen language, or null when none is set. */
  language: string | null;
  /** The deployment's own language, which an unset choice reads as. */
  deployment: string;
  languages: LanguageOption[];
}

/** A refusal the server named, shown in the client's own words (tenet D11). */
export class LanguagePreferenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LanguagePreferenceError';
    this.code = code;
  }
}

async function call(init: RequestInit): Promise<LanguagePreferenceView> {
  const token = localStorage.getItem('idToken');
  if (!token) throw new LanguagePreferenceError('UNAUTHENTICATED', 'Not authenticated');
  const resp = await fetch(personUrl('/me/language'), {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await resp.json().catch(() => ({})) as Partial<LanguagePreferenceView> & { code?: string; error?: string };
  if (!resp.ok) throw new LanguagePreferenceError(body.code || `HTTP_${resp.status}`, body.error || resp.statusText);
  return {
    language: typeof body.language === 'string' ? body.language : null,
    deployment: typeof body.deployment === 'string' ? body.deployment : '',
    languages: Array.isArray(body.languages) ? body.languages : [],
  };
}

/** The caller's language and the choices. */
export function fetchLanguagePreference(): Promise<LanguagePreferenceView> {
  return call({ method: 'GET' });
}

/** Choose a declared language, or clear the choice with null; answers the setting after the change. */
export function setLanguagePreference(language: string | null): Promise<LanguagePreferenceView> {
  return call({ method: 'POST', body: JSON.stringify({ language }) });
}
