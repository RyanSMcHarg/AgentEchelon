/**
 * A SIGNED-IN PERSON'S OWN LANGUAGE (ADR-062 decision 4, ADR-060 decision 1): `GET` and `POST /me/language`.
 *
 * The chat app's Account settings read and set the language a person wants messages addressed to them in. It is a
 * CHOICE among the languages the deployment declares (`lib/config/languages.ts`), stored as the declared tag under
 * `preferences.preferredLanguage` on the person's user-profile row, the store the reply preferences already live in.
 * Read by the router and the processor as `person:preferredLanguage`: a closed enum, so it may decide, and a fact about
 * the person, so it reaches only a message addressed to them.
 *
 *  - `GET` answers the stored language (a declared tag, or `null` when none is set or the stored one is no longer
 *    declared), the deployment's own language, and the declared languages with their names.
 *  - `POST { language }` stores a declared tag, or clears the choice with `null`; any other value is refused.
 *
 * TWO LAYERS (tenet D3). The person is the caller the edge authorizer resolved (`callerPersonArn`), never a field of
 * the request, so a person sets only their own language. This function's role reads only the `preferences` attribute
 * of a user-profile row and writes only `preferences` and `updatedAt`, and is denied every item whose key carries a
 * `#` (a person's notice preferences, contact copies), so it can neither read an onboarding answer nor change anything
 * else (`conversations-stack.ts`, deny-tested in `a-person-sets-their-own-language.test.ts`).
 *
 * A guest, a one-conversation session and a host assertion resolve to nobody here: they have no account to set.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { callerPersonArn } from './lib/auth.js';
import { personIdFromArn } from './lib/person-arn.js';
import { responder, originsFrom, DEV_ORIGIN, requestOrigin, type HttpResult } from './lib/http-response.js';
import { PREFERRED_LANGUAGE_KEY } from './lib/variables.js';
import { declaredLanguageEntries, deploymentLanguage, deploymentLanguages, resolveLanguageTag, type LanguageEntry } from '../../lib/config/languages.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

export const LANGUAGE_MINE_ROUTE = '/me/language';

const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN) }, methods: 'GET,POST,OPTIONS' });

/** What the setting shows. */
export interface LanguagePreferenceView {
  /** The person's chosen language, a declared tag, or null. */
  language: string | null;
  /** The deployment's own language, which an unset choice reads as. */
  deployment: string;
  /** Every language the person may choose, in the deployment's order. */
  languages: LanguageEntry[];
}

export interface LanguageMineDeps {
  doc: Sender;
  table: string;
  now(): Date;
  declared?: readonly string[];
}

let defaults: LanguageMineDeps | null = null;
const depsOf = (): LanguageMineDeps => (defaults ??= {
  doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })),
  table: process.env.USER_PROFILE_TABLE || '',
  now: () => new Date(),
});

function bodyOf(event: APIGatewayProxyEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The view of what is stored. A stored tag the deployment no longer declares reads as no choice. */
export function languageView(stored: unknown, declared: readonly string[]): LanguagePreferenceView {
  const tag = typeof stored === 'string' ? resolveLanguageTag(stored, declared) : undefined;
  return { language: tag && declared.includes(tag) ? tag : null, deployment: deploymentLanguage(declared), languages: declaredLanguageEntries(declared) };
}

async function readStored(deps: LanguageMineDeps, personId: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const res = await deps.doc.send(new GetCommand({
      TableName: deps.table,
      Key: { personId },
      ProjectionExpression: 'preferences',
    }));
    const prefs = (res?.Item as { preferences?: Record<string, unknown> } | undefined)?.preferences;
    return { ok: true, value: prefs && typeof prefs === 'object' ? prefs[PREFERRED_LANGUAGE_KEY] : undefined };
  } catch (err) {
    console.warn('[language-preference-api] the stored language could not be read', { err: (err as Error)?.name });
    return { ok: false };
  }
}

/** Store or clear the choice: two writes, because DynamoDB cannot set a path under a map that does not exist yet. */
async function writeStored(deps: LanguageMineDeps, personId: string, tag: string | null): Promise<void> {
  const now = deps.now().toISOString();
  if (tag === null) {
    await deps.doc.send(new UpdateCommand({
      TableName: deps.table,
      Key: { personId },
      UpdateExpression: 'REMOVE preferences.#k SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(preferences)',
      ExpressionAttributeNames: { '#k': PREFERRED_LANGUAGE_KEY },
      ExpressionAttributeValues: { ':now': now },
    })).catch((err: { name?: string }) => {
      // Nothing stored is nothing to clear.
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    });
    return;
  }
  await deps.doc.send(new UpdateCommand({
    TableName: deps.table,
    Key: { personId },
    UpdateExpression: 'SET preferences = if_not_exists(preferences, :empty), updatedAt = :now',
    ExpressionAttributeValues: { ':empty': {}, ':now': now },
  }));
  await deps.doc.send(new UpdateCommand({
    TableName: deps.table,
    Key: { personId },
    UpdateExpression: 'SET preferences.#k = :v, updatedAt = :now',
    ExpressionAttributeNames: { '#k': PREFERRED_LANGUAGE_KEY },
    ExpressionAttributeValues: { ':v': tag, ':now': now },
  }));
}

export async function handleLanguageMine(event: APIGatewayProxyEvent, deps: LanguageMineDeps = depsOf()): Promise<HttpResult> {
  const origin = requestOrigin(event);
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return http.empty(204, origin);
  if (method !== 'GET' && method !== 'POST') return http.error(405, `${method} not supported`, origin);
  const personId = personIdFromArn(await callerPersonArn(event) || '') || '';
  if (!personId) return http.error(401, 'this sign-in names no person', origin, 'NO_PERSON');
  if (!deps.table) return http.error(503, 'the language setting is not configured on this deployment', origin, 'NOT_CONFIGURED');
  const declared = deps.declared ?? deploymentLanguages();

  if (method === 'POST') {
    const body = bodyOf(event);
    const asked = body?.language;
    // A DECLARED TAG, EXACTLY, OR NULL. The value is a choice among what the deployment speaks, never text to resolve.
    if (!(asked === null || (typeof asked === 'string' && declared.includes(asked)))) {
      return http.error(400, `language is one of ${declared.join(', ')}, or null to clear it`, origin, 'UNDECLARED_LANGUAGE');
    }
    await writeStored(deps, personId, asked as string | null);
    console.log('[language-preference-api] a language was set', { cleared: asked === null });
  }

  const stored = await readStored(deps, personId);
  if (!stored.ok) return http.error(503, 'your language could not be read', origin, 'UNREADABLE');
  return http.respond(200, languageView(stored.value, declared), origin);
}

export const handler = async (event: APIGatewayProxyEvent): Promise<HttpResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  try {
    return await handleLanguageMine(event);
  } catch (err) {
    console.error('[language-preference-api] the request failed', { err: (err as Error)?.name || 'error' });
    return http.error(500, 'the language could not be changed', requestOrigin(event));
  }
};

/** Test seam. */
export function __setLanguageMineDepsForTests(d: LanguageMineDeps | null): void {
  defaults = d;
}
