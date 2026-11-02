/**
 * THE PROVISIONER'S BUILD PATH: ONE WAY AN ASSISTANT'S IDENTITY COMES TO EXIST (ADR-048, amended 2026-10-24).
 *
 * Every assistant is an Amazon Lex bot of its own and an `AppInstanceBot` wired to it, both stamped
 * `provisioner = runtime`, which is the only thing the provisioner's grant reaches
 * (`runtimeAssistantProvisioningAllow`). One function runs it, the provisioner (`assistant-provisioner-function.ts`),
 * on a session of `RuntimeAssistantProvisionerRole` tagged with the classification, for both ways an assistant is
 * asked for:
 *
 *   - `manage-assistants` (the console) asks it to build a console-created assistant (`op: 'build'`) and to remove
 *     one being retired (`op: 'remove'`);
 *   - a stack's seed (`seed-declared-assistants.ts`) asks it to seed the deployment's declaration
 *     (`op: 'seed-declared'`, `declared-assistants.ts`).
 *
 * What is written around the build (the directory entry and the assignment record) differs by how the assistant
 * was asked for, because the two record different facts: a console-created assistant's descriptor, a declared
 * one's origin. What an identity IS, how it is removed, and how "already gone" is established, are said once, here.
 */
import { createHash } from 'crypto';
import {
  CreateAppInstanceBotCommand,
  DescribeAppInstanceBotCommand,
  DeleteAppInstanceBotCommand,
  ListAppInstanceBotsCommand,
  UpdateAppInstanceBotCommand,
  type ChimeSDKIdentityClient,
} from '@aws-sdk/client-chime-sdk-identity';
import { ListBotsCommand, type LexModelsV2Client } from '@aws-sdk/client-lex-models-v2';
import { assistantBotConfiguration, PROVISIONER_TAG, RUNTIME_PROVISIONER } from './assistant-identity.js';
import {
  createDraftBot,
  resolveTestAliasId,
  configureBotAlias,
  allowChimeToInvoke,
  lexBotAliasArn,
  deleteBot,
} from './assistant-lex-bot.js';

/** The Amazon Chime SDK identity and Amazon Lex clients a build or a removal at one classification runs with. */
export interface ProvisionerClients {
  identity: Pick<ChimeSDKIdentityClient, 'send'>;
  lex: LexModelsV2Client;
}

/** The ids a build has created so far, recorded as it goes so a build killed partway can be removed. */
export interface Built {
  lexBotId?: string;
  botArn?: string;
}

export interface IdentitySpec {
  assistantId: string;
  classification: string;
  role: string;
  /** The name the identity shows in a room. */
  displayName: string;
  /** One per build, so a re-create of a released name never replays an old identity request. */
  createdAt: string | undefined;
  /** The Amazon Lex bot's name; unique in the account. */
  lexBotName: string;
  description: string;
  /** The role Amazon Lex runs the bot as. */
  lexBotRoleArn: string;
  /** The function that fulfills the bot's turns: its classification's router, or the admin assistant's silent handler. */
  fulfillmentArn: string;
  /** Text conversation logs, when given. */
  logGroupArn?: string;
  appInstanceArn: string;
  region: string;
  account: string;
  /** False for an identity that must stay silent when it joins (a duel's alt, the admin assistant). */
  welcome: boolean;
}

/** The tags every provisioner-owned identity and Amazon Lex bot carries. */
export function provisionerTags(classification: string, assistantId: string, role: string): Record<string, string> {
  return { classification, assistant: assistantId, role, [PROVISIONER_TAG]: RUNTIME_PROVISIONER };
}

/**
 * The identity create's idempotency token, one per BUILD. A fixed per-name token would be replayed by a
 * re-create of a released name with a different Lex alias, which Amazon Chime SDK either refuses as a
 * mismatch or answers with the deleted identity. Hashed, because the token is at most 64 characters and
 * an id alone can be 63.
 */
export const identityRequestToken = (assistantId: string, createdAt: string | undefined): string =>
  `rt-${createHash('sha256').update(`${assistantId}\n${createdAt ?? ''}`).digest('hex').slice(0, 40)}`;

/**
 * A console-created assistant's Amazon Lex bot name: the id itself, so distinct ids never share one. Here, beside
 * the identity token, so the console's validation (`manage-assistants.ts`) reads it without bundling the
 * provisioner's handler and its clients.
 */
export const lexBotNameFor = (assistantId: string): string => `rt-${assistantId}`;

/**
 * Build the Amazon Lex bot and the identity. `built` is filled as each id exists, and `checkpoint` (when
 * given) is called after each, so a caller can record the ids before the next minutes of work. Throws on
 * any failure, leaving what was built in `built` for the caller to remove (`removeBuilt`).
 */
export async function buildIdentity(
  clients: ProvisionerClients,
  spec: IdentitySpec,
  built: Built,
  checkpoint: () => Promise<void> = async () => undefined,
): Promise<{ lexBotId: string; botArn: string }> {
  const { identity, lex } = clients;
  const tags = provisionerTags(spec.classification, spec.assistantId, spec.role);
  try {
    built.lexBotId = await createDraftBot(lex, {
      botName: spec.lexBotName,
      description: spec.description,
      roleArn: spec.lexBotRoleArn,
      tags,
      onCreated: async (botId) => { built.lexBotId = botId; await checkpoint(); },
    });
  } catch (err) {
    built.lexBotId = built.lexBotId || (err as { partialBotId?: string }).partialBotId;
    throw err;
  }
  const aliasId = await resolveTestAliasId(lex, built.lexBotId);
  if (!aliasId) throw new Error('the Lex bot has no test alias');
  // Text conversation logs: one record per Lex invocation is what tells "Lex asked twice" from "the router
  // ran one turn twice" (`lib/correlation.ts`).
  await configureBotAlias(lex, built.lexBotId, aliasId, spec.fulfillmentArn, spec.logGroupArn || undefined);
  await allowChimeToInvoke(lex, {
    region: spec.region, accountId: spec.account, botId: built.lexBotId, botAliasId: aliasId, appInstanceArn: spec.appInstanceArn,
  });

  // The identity is created WITH its tags: the grant is conditioned on what the request stamps, so an
  // untagged create is refused rather than left to a second call that could fail.
  const bot = await identity.send(new CreateAppInstanceBotCommand({
    AppInstanceArn: spec.appInstanceArn,
    ClientRequestToken: identityRequestToken(spec.assistantId, spec.createdAt),
    Name: spec.displayName || spec.assistantId,
    Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
    Configuration: assistantBotConfiguration({
      lexBotAliasArn: lexBotAliasArn(spec.region, spec.account, built.lexBotId, aliasId),
      ...(spec.welcome ? { welcomeIntent: 'WelcomeIntent' } : {}),
    }),
  }));
  built.botArn = bot.AppInstanceBotArn;
  if (!built.botArn) throw new Error('the identity was created without an ARN');
  await checkpoint();
  return { lexBotId: built.lexBotId, botArn: built.botArn };
}

const isNotFound = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name;
  return name === 'ParameterNotFound' || name === 'NotFoundException' || name === 'ResourceNotFoundException';
};

/**
 * Every shape an access denial takes. The provisioner's grant is conditioned on tags a deleted resource no longer
 * carries, so a read or delete of one is refused by IAM (`AccessDeniedException`, unmodeled in the Amazon Chime SDK
 * and Amazon Lex V2 clients, so it arrives as the service's base exception under that name), and Amazon Chime SDK
 * answers an account administrator with `ForbiddenException`. A denial says only that the caller may not act; absence
 * is established by a listing ({@link identityListed}, {@link lexBotListed}), never by the denial itself.
 */
const DENIAL_NAMES = new Set(['AccessDeniedException', 'AccessDenied', 'ForbiddenException', 'UnauthorizedClientException', 'UnauthorizedException']);
const isAccessDenied = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return DENIAL_NAMES.has(e?.name ?? '') || e?.$metadata?.httpStatusCode === 403;
};

/** Whether the app instance still lists the identity. */
async function identityListed(identity: ProvisionerClients['identity'], appInstanceArn: string, botArn: string): Promise<boolean> {
  let token: string | undefined;
  do {
    const res = await identity.send(new ListAppInstanceBotsCommand({ AppInstanceArn: appInstanceArn, MaxResults: 50, NextToken: token }));
    if ((res?.AppInstanceBots ?? []).some((b) => b.AppInstanceBotArn === botArn)) return true;
    token = res?.NextToken;
  } while (token);
  return false;
}

/** Whether the account still lists the Amazon Lex bot, in any status. */
async function lexBotListed(lex: LexModelsV2Client, lexBotId: string): Promise<boolean> {
  let token: string | undefined;
  do {
    const res = await lex.send(new ListBotsCommand({ maxResults: 1000, nextToken: token }));
    if ((res?.botSummaries ?? []).some((b) => b.botId === lexBotId)) return true;
    token = res?.nextToken;
  } while (token);
  return false;
}

/**
 * True when the identity is gone. Delete raises no NotFound, so existence is read first - and a deleted
 * bot answers Describe with a denial, not NotFound: `ForbiddenException` for an account administrator
 * (measured 2026-10-13 and 2026-10-27), and the IAM layer's `AccessDeniedException` for the provisioner's
 * session, whose grant needs tags a deleted bot no longer carries. So a denial is settled by whether the
 * app instance still lists the bot, and a listing that fails leaves the identity counted as present.
 */
export async function deleteIdentity(clients: ProvisionerClients, appInstanceArn: string, botArn: string): Promise<boolean> {
  const { identity } = clients;
  try {
    await identity.send(new DescribeAppInstanceBotCommand({ AppInstanceBotArn: botArn }));
  } catch (err) {
    if (isNotFound(err)) return true;
    if (isAccessDenied(err) && !(await identityListed(identity, appInstanceArn, botArn).catch(() => true))) return true;
    console.error('[assistant-provisioner][SecurityEvent] could not read the identity before deleting it', { botArn, name: (err as Error)?.name, error: (err as Error)?.message });
    return false;
  }
  try {
    await identity.send(new DeleteAppInstanceBotCommand({ AppInstanceBotArn: botArn }));
    return true;
  } catch (err) {
    console.error('[assistant-provisioner][SecurityEvent] could not delete the identity; it outlives its assistant', { botArn, error: (err as Error)?.message });
    return false;
  }
}

/**
 * Delete an Amazon Lex bot. True when it is gone (a missing bot is gone). A deleted bot carries no tags, so
 * `DeleteBot` answers the provisioner's session with an access denial rather than NotFound; a denial is settled
 * by whether the account still lists the bot, and a listing that fails leaves the bot counted as present.
 */
export async function deleteLexBot(clients: ProvisionerClients, lexBotId: string): Promise<boolean> {
  try {
    await deleteBot(clients.lex, lexBotId);
    return true;
  } catch (err) {
    if (isNotFound(err)) return true;
    if (isAccessDenied(err) && !(await lexBotListed(clients.lex, lexBotId).catch(() => true))) return true;
    console.error('[assistant-provisioner] could not delete the Lex bot', { lexBotId, name: (err as Error)?.name, error: (err as Error)?.message });
    return false;
  }
}

/**
 * Remove an identity and its Amazon Lex bot, identity first: the identity is what can act, so it is the
 * hard stop. Returns what could not be removed.
 */
export async function removeBuilt(clients: ProvisionerClients, appInstanceArn: string, built: Built): Promise<string[]> {
  const leftover: string[] = [];
  if (built.botArn && !(await deleteIdentity(clients, appInstanceArn, built.botArn))) leftover.push(`identity ${built.botArn}`);
  if (built.lexBotId && !(await deleteLexBot(clients, built.lexBotId))) leftover.push(`Lex bot ${built.lexBotId}`);
  return leftover;
}

/** What a rename did: put the new name on, found it already there, or found a profile version's name on it. */
export type IdentityRename = 'renamed' | 'unchanged' | 'named-by-version';

/**
 * Put a declaration's new name on an identity that still shows the name it was provisioned with. The NAME AND
 * NOTHING ELSE changes: `UpdateAppInstanceBot` replaces the whole record, so the configuration and metadata the
 * identity already has are read back and re-sent, as the name applier does (`apply-assistant-name.ts`), and the
 * Amazon Lex wiring stays what the build made it. An identity showing any other name was named by an active
 * profile version, whose name wins (`ProfileRegistry.displayNameFor`), so it is left as it is.
 */
export async function renameIdentity(clients: ProvisionerClients, botArn: string, provisionedName: string, to: string): Promise<IdentityRename> {
  const { identity } = clients;
  const current = await identity.send(new DescribeAppInstanceBotCommand({ AppInstanceBotArn: botArn }));
  const name = current?.AppInstanceBot?.Name;
  if (name === to) return 'unchanged';
  if (name !== provisionedName) return 'named-by-version';
  const configuration = current?.AppInstanceBot?.Configuration;
  if (!configuration) throw new Error(`the identity ${botArn} returned no configuration to keep`);
  await identity.send(new UpdateAppInstanceBotCommand({
    AppInstanceBotArn: botArn,
    Name: to,
    Metadata: current.AppInstanceBot?.Metadata ?? '',
    Configuration: configuration,
  }));
  return 'renamed';
}
