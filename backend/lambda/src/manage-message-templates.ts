/**
 * AN ASSISTANT'S OWN MESSAGE TEMPLATES, READ AND WRITTEN FROM THE CONSOLE (ADR-062 decisions 2 and 3).
 *
 * Routes, each in the admin form and the team form a team member's console session reaches for an assistant
 * its team owns (SPEC-ADMIN-CONSOLE FR48):
 *   - `GET  /admin/templates?profileName=<assistant>` and `GET /admin/assistants/{assistant}/templates`: for each
 *     template the platform ships, the shipped source and the active source in the classification's family and
 *     in the assistant's own family, so the console shows the three side by side.
 *   - `POST /admin/templates/save` and `POST /admin/assistants/{assistant}/templates/save`, `{ profileName, source,
 *     message? }`: store the source in the assistant's own family and make it active. A template named for the
 *     message it words is used from then; one under a
 *     name of its own (`message` says which it words) is used once the version's `messages` names it.
 *   - `POST /admin/templates/rollback` and `POST /admin/assistants/{assistant}/templates/rollback`, `{ profileName,
 *     name }`: return the assistant's template of that name, one it rewords or one of its own, to the version active
 *     before.
 *
 * WHAT IS WRITTEN IS BOUNDED THREE WAYS. The key is built here from the assistant the route names, never from
 * the body, so a write lands only in `templates/<classification>/_assistants/<assistant>/`. This function's
 * role may write that family in every classification and nothing else under `templates/` (the classification's
 * and the shipped families are refused at IAM). And a team member's session reaches only the assistants their
 * team owns (`teamSessionPolicy`), which `requireOwnedAssistant` reads again here. A source is stored only when
 * it names a template the platform ships, parses, and fits that template's call site (`storedTemplateMisfit`),
 * so a saved rewording can never ask a call site for a value it does not supply.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { callerActor, callerCanManageProfiles, parseJsonBody, respond as authRespond } from './lib/auth.js';
import { requireOwnedAssistant, isRefusal } from './lib/assistant-scope.js';
import { listAssistantIdentities, type AssistantIdentity } from './lib/assistant-ownership.js';
import { chimeIdentityClient } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { parseTemplate, TemplateParseError, TEMPLATE_NAME } from './lib/document-template.js';
import { shippedMessageTemplates, voiceAllowed } from './lib/shipped-message-templates.js';
import { declaredLanguageEntries } from '../../lib/config/languages.js';
import { storedTemplateMisfit } from './lib/message-template-selection.js';
import { buildSourceTable, sourceLookup, withUnreadCatalog, VARIABLE_NAME, type SourceLookup } from './lib/variables.js';
import {
  activateTemplate,
  getTemplateBody,
  listTemplates,
  putTemplate,
  rollbackTemplate,
  ASSISTANT_SEGMENT,
  TemplateReferenceError,
  type TemplateOwner,
  type TemplateStoreDeps,
} from './lib/template-store.js';

export interface TemplatesDeps {
  store?: TemplateStoreDeps;
  /** Every assistant identity with its classification; default the app instance's. */
  identities?: () => Promise<AssistantIdentity[]>;
  /** The team route's ownership check; default `requireOwnedAssistant`. */
  scope?: typeof requireOwnedAssistant;
}

/** One template as the console shows it: what ships, what the classification and the assistant have active. */
export interface TemplateListing {
  name: string;
  kind: 'message' | 'prompt';
  description: string;
  shipped: string;
  /** The message may be saved as `fill: voice`: its call site may await a model (ADR-062 decision 4). */
  voiceable?: boolean;
  classification?: { contentHash: string; source: string };
  own?: { contentHash: string; source: string; history: string[] };
}

/** Every active template in an assistant's family, by name: the ones a version's `messages` may name. */
export type AssistantFamily = Record<string, { contentHash: string; source: string; history: string[] }>;

/** The active source of each template a family holds, by name. */
async function activeSources(
  classification: string,
  owner: TemplateOwner,
  store: TemplateStoreDeps | undefined,
): Promise<Map<string, { contentHash: string; source: string; history: string[] }>> {
  const out = new Map<string, { contentHash: string; source: string; history: string[] }>();
  for (const t of await listTemplates(classification, store, owner)) {
    if (!t.active) continue;
    out.set(t.name, { contentHash: t.active, source: await getTemplateBody(classification, t.name, t.active, store, owner), history: t.history });
  }
  return out;
}

/** Every shipped template, with the classification's and the assistant's active versions, and the assistant's whole family. */
export async function listAssistantTemplates(
  classification: string,
  assistant: string,
  store?: TemplateStoreDeps,
): Promise<{ templates: TemplateListing[]; family: AssistantFamily }> {
  const [classwide, own] = await Promise.all([
    activeSources(classification, { family: 'classification' }, store),
    activeSources(classification, { family: 'assistant', assistant }, store),
  ]);
  const templates = [...shippedMessageTemplates().values()].map(({ entry, source }) => {
    const c = classwide.get(entry.name);
    const o = own.get(entry.name);
    return {
      name: entry.name,
      kind: entry.kind,
      description: entry.description,
      shipped: source,
      ...(entry.voiceable ? { voiceable: true } : {}),
      ...(c ? { classification: { contentHash: c.contentHash, source: c.source } } : {}),
      ...(o ? { own: o } : {}),
    };
  });
  return { templates, family: Object.fromEntries(own) };
}

/**
 * Why a source cannot be saved as an assistant's own template, or nothing. `message` names the shipped template it
 * words when its own name is not that template's; absent, its name must be one the platform ships.
 *
 * IT IS CHECKED AGAINST THE NAME IT IS STORED UNDER: the source's own name is the key it is stored and activated by, so a
 * source named for a shipped template is said wherever that template is, and must fit that template's call site and
 * voice whatever `message` says. One naming a shipped template other than `message` is refused, rather than checked
 * against one call site and said at another.
 */
/**
 * WHAT A FIELD MAY BIND TO WHEN IT IS SAVED. A template is saved before, and apart from, the version that names it, so
 * a field bound to a published source fits as the catalog's least-permitting reading admits it, and a field bound to
 * a bare name fits as a version's variable, read as member text. The version that says the template is the gate:
 * its validation requires the variable it names, and where it is served a template whose field the served version
 * does not supply is passed over for the next one (`message-template-selection.ts`).
 */
const SAVE_LOOKUP: SourceLookup = (() => {
  const published = withUnreadCatalog(sourceLookup(buildSourceTable({ catalog: [] })));
  return (name: string) => published(name) ?? (VARIABLE_NAME.test(name)
    ? { source: name, type: 'string', trust: 'member', describesPerson: true, availability: 'person-settled', insertAs: 'longText', origin: "a version's variable, checked where the version that names it is served" }
    : undefined);
})();

export function saveRefusal(source: unknown, message?: unknown): string | undefined {
  if (typeof source !== 'string' || !source.trim()) return 'source is the template text to save';
  if (source.length > 16_000) return 'a message template is at most 16000 characters';
  let parsed;
  try {
    parsed = parseTemplate(source);
  } catch (err) {
    return err instanceof TemplateParseError ? err.message : 'the template could not be parsed';
  }
  if (message !== undefined && (typeof message !== 'string' || !shippedMessageTemplates().has(message))) {
    return 'message names the template the platform ships that this one words';
  }
  if (typeof message === 'string' && message !== parsed.name && shippedMessageTemplates().has(parsed.name)) {
    return `"${parsed.name}" is a template the platform ships, so it is stored and said as ${parsed.name}; save it without \`message\`, or under a name of its own to word ${message}`;
  }
  const shipped = shippedMessageTemplates().get(typeof message === 'string' ? message : parsed.name);
  if (!shipped) return `"${parsed.name}" is not a template the platform says; an assistant rewords one it ships, or names it in \`message\``;
  if (parsed.fill === 'voice' && !voiceAllowed(shipped.entry.name)) {
    return `"${parsed.name}" cannot be fill: voice: ${shipped.entry.name} is said where no model call is awaited, so it is said as written`;
  }
  const misfit = storedTemplateMisfit(parsed, shipped.template, { lookup: SAVE_LOOKUP });
  return misfit ? `"${parsed.name}" cannot be saved: ${misfit}` : undefined;
}

export async function handleTemplates(event: APIGatewayProxyEvent, deps: TemplatesDeps = {}): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;
  const respond = (code: number, body: unknown) => authRespond(code, body, origin);
  const method = event.httpMethod;
  const path = event.path || '';
  if (method === 'OPTIONS') return respond(200, { ok: true });

  const actor = await callerActor(event);
  if (!actor) return respond(401, { error: 'Unauthorized' });
  if (!callerCanManageProfiles(event)) return respond(403, { error: 'manage-profiles capability required' });

  // THE TEAM ROUTE NAMES ITS ASSISTANT, and the caller's team must own it. A body naming another is refused.
  const scope = await (deps.scope ?? requireOwnedAssistant)(event, origin);
  if (isRefusal(scope)) return scope;
  let body: Record<string, unknown> = {};
  if (method === 'POST') {
    const parsed = parseJsonBody<Record<string, unknown>>(event, origin);
    if ('statusCode' in parsed) return parsed;
    body = parsed.body && typeof parsed.body === 'object' ? parsed.body : {};
  }
  const named = typeof body.profileName === 'string' ? body.profileName : event.queryStringParameters?.profileName;
  if (scope && named && named !== scope.assistant) {
    return respond(403, { error: 'This route writes only the assistant it names', code: 'ASSISTANT_MISMATCH' });
  }
  const assistant = scope?.assistant ?? named;
  if (!assistant || !ASSISTANT_SEGMENT.test(assistant)) return respond(400, { error: 'profileName names the assistant whose templates these are' });

  // THE ASSISTANT'S CLASSIFICATION, from its identity: the prefix its family sits under.
  let identities: AssistantIdentity[];
  try {
    identities = scope?.bots ?? (await (deps.identities ?? (() => listAssistantIdentities(chimeIdentityClient({ region: process.env.AWS_REGION || 'us-east-1' }), process.env.APP_INSTANCE_ARN || '')))())
      .filter((i) => i.assistant === assistant);
  } catch (err) {
    console.error('[manage-message-templates] the assistant\'s identity could not be read', { assistant, err: (err as Error)?.name });
    return respond(503, { error: 'The assistant could not be resolved; try again' });
  }
  const classification = identities.find((i) => i.classification)?.classification;
  if (!classification) return respond(404, { error: `No assistant "${assistant}" serves a classification here` });
  const owner: TemplateOwner = { family: 'assistant', assistant };

  try {
    if (method === 'GET') {
      // THE DEPLOYMENT'S LANGUAGES (ADR-062 decision 4), its own first: the variants an editor may write and the order's steps.
      return respond(200, { assistant, classification, languages: declaredLanguageEntries(), ...(await listAssistantTemplates(classification, assistant, deps.store)) });
    }
    if (method === 'POST' && path.endsWith('/templates/save')) {
      const refusal = saveRefusal(body.source, body.message);
      if (refusal) return respond(400, { error: refusal, code: 'TEMPLATE_REFUSED' });
      const put = await putTemplate(classification, body.source as string, deps.store, { owner });
      const activated = await activateTemplate(classification, put.name, put.contentHash, deps.store, { owner });
      console.log('[manage-message-templates] saved', { actor, assistant, classification, name: put.name, contentHash: put.contentHash, changed: activated.changed });
      return respond(200, { name: put.name, contentHash: put.contentHash, ...(activated.previous ? { previous: activated.previous } : {}), changed: activated.changed });
    }
    if (method === 'POST' && path.endsWith('/templates/rollback')) {
      // ANY TEMPLATE THIS ASSISTANT'S FAMILY HOLDS: a shipped name it rewords, or a name of its own a version's `messages`
      // says a message from. The key is built from the route's assistant, so a rollback never reaches another family, and a
      // name the family holds no earlier version of is refused by the store (409).
      const name = typeof body.name === 'string' ? body.name : '';
      if (!TEMPLATE_NAME.test(name)) return respond(400, { error: 'name is a template this assistant holds' });
      const rolled = await rollbackTemplate(classification, name, deps.store, { owner });
      console.log('[manage-message-templates] rolled back', { actor, assistant, classification, name, ...rolled });
      return respond(200, { name, ...rolled });
    }
    return respond(404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof TemplateReferenceError) return respond(409, { error: err.message.replace(/^\[TemplateStore\] /, '') });
    console.error('[manage-message-templates] failed', { assistant, err: (err as Error)?.name, message: (err as Error)?.message });
    return respond(500, { error: 'The templates could not be read or written' });
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish: the ownership check reads it.
  await loadProfileRegistry();
  return handleTemplates(event);
};
