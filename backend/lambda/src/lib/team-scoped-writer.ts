/**
 * A TEAM ROUTE WRITES ON A SESSION BOUND TO ITS ASSISTANT (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT 5.1, tenet D3).
 *
 * A team member's console session reaches `.../assistants/{assistant}/...` only for an assistant their team owns, and
 * the handler reads that ownership again (`requireOwnedAssistant`). IAM holds the third binding: a team route's
 * writes go out on a session of the function's team writer role, tagged with the assistant the route's path names,
 * and every grant of that role names `${aws:PrincipalTag/assistant}`. A write aimed at any other assistant is refused
 * by IAM whatever the handler decided.
 *
 * WHAT GOES OUT ON THE SESSION. A store client wrapped by `writesAsTeam` sends each write command on the team
 * session while one is held (`asTeamWriter`) and each read on the function's own role, so the console's pages keep
 * the reads they show and every write is narrowed. Outside a team route nothing is held and every command goes out
 * on the function's own role, which keeps the reach an administrator's route needs.
 *
 * FAILS CLOSED. A function with no team writer role, an assistant id that is not one, or an assume STS refuses each
 * throws `TeamWriterRefused` at the write, and the write is not made on the function's own role.
 *
 * OPENED AT THE FIRST WRITE: a team route that only reads, or that the handler refuses, never assumes the role.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { ASSISTANT_ID_PATTERN } from './assistant-acting-policy.js';
import { ALT_NAME_PATTERN, TEAM_WRITER_ROLE_ARN_ENV, TEAM_WRITER_TAG } from './team-writer-tags.js';

/** The assistant a team route's path names, and, while an alt's candidate is published, that assistant's alt. */
export interface TeamWriterBinding {
  assistant: string;
  alt?: string;
}

/** Where a binding's credentials come from: STS by default (`assumeTeamWriter`). */
export type TeamWriterCredentials = (binding: TeamWriterBinding) => Promise<AwsCredentialIdentity>;

export class TeamWriterRefused extends Error {
  constructor(public readonly reason: string) {
    super(`the team writer session was refused: ${reason}`);
    this.name = 'TeamWriterRefused';
  }
}

interface Held {
  binding: TeamWriterBinding;
  source: TeamWriterCredentials;
  credentials?: Promise<AwsCredentialIdentity>;
  /** One client per kind per session, built on the session's credentials. */
  clients: Map<string, unknown>;
}

const held = new AsyncLocalStorage<Held>();

/** An SDK command by its class name; a digit suffix is a bundler's rename of the same class. */
const SDK_COMMAND = /^([A-Za-z0-9]+?)Command\d*$/;
/** The operations that read. Every other SDK command is a write. */
const READ_OPERATION = /^(Get|List|Describe|Head|Query|Scan|BatchGet|Select)/;

/** Whether a command an SDK client sends changes something: every SDK command that is not a read. */
export function isWriteCommand(command: unknown): boolean {
  const name = (command as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
  if (typeof name !== 'string') return false;
  const m = SDK_COMMAND.exec(name);
  return !!m && !READ_OPERATION.test(m[1]);
}

/** The binding the current work writes under, or undefined outside a team route. */
export function teamWriterBinding(): TeamWriterBinding | undefined {
  return held.getStore()?.binding;
}

/** Run `work` with its writes on the team writer session for `binding`. */
export function asTeamWriter<T>(
  binding: TeamWriterBinding,
  work: () => Promise<T>,
  source: TeamWriterCredentials = assumeTeamWriter,
): Promise<T> {
  return held.run({ binding: { ...binding }, source, clients: new Map() }, work);
}

/**
 * Run `work` as the team writer of the assistant a team route's path names (`scopedAssistant`), or on the function's
 * own role when the route names none.
 */
export function onTeamRoute<T>(
  assistant: string | null | undefined,
  work: () => Promise<T>,
  source?: TeamWriterCredentials,
): Promise<T> {
  return assistant ? asTeamWriter({ assistant }, work, source) : work();
}

/**
 * Run `work` with the held team writer also bound to `alt`, the alt of the held assistant's role, which the caller
 * derived on the server from that assistant. Outside a team route `work` runs as it is.
 */
export function withTeamWriterAlt<T>(alt: string, work: () => Promise<T>): Promise<T> {
  const h = held.getStore();
  if (!h) return work();
  return held.run({ binding: { assistant: h.binding.assistant, alt }, source: h.source, clients: new Map() }, work);
}

async function clientOn<C>(h: Held, kind: string, make: (credentials: AwsCredentialIdentity) => C): Promise<C> {
  h.credentials ??= h.source(h.binding);
  const credentials = await h.credentials;
  let client = h.clients.get(kind) as C | undefined;
  if (!client) {
    client = make(credentials);
    h.clients.set(kind, client);
  }
  return client;
}

/**
 * Wrap a store client so a write goes out on the held team writer session and everything else on `ambient`.
 *
 * `kind` names the client (`ssm`, `s3`, `ddb-doc`): one session client of each kind is built per session. `make`
 * builds the same client on given credentials. Everything other than `send` is the ambient client's.
 */
export function writesAsTeam<C extends { send: (...args: never[]) => unknown }>(
  ambient: C,
  kind: string,
  make: (credentials: AwsCredentialIdentity) => C,
): C {
  return new Proxy(ambient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'send') return value;
      return (...args: never[]) => {
        const h = held.getStore();
        if (!h || !isWriteCommand(args[0])) return (value as (...a: never[]) => unknown).apply(target, args);
        return clientOn(h, kind, make).then((client) => (client.send as (...a: never[]) => unknown).apply(client, args));
      };
    },
  });
}

/** Reused until this close to expiry: an assume per write would cost a round trip each. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const sessions = new Map<string, AwsCredentialIdentity>();
let sts: STSClient | null = null;

/**
 * A session of this function's team writer role, tagged with the binding. The literal tag keys are the ones the
 * role's trust policy requires and its grants name (`TEAM_WRITER_TAG`).
 */
export const assumeTeamWriter: TeamWriterCredentials = async (binding) => {
  const roleArn = process.env[TEAM_WRITER_ROLE_ARN_ENV] || '';
  if (!roleArn) throw new TeamWriterRefused('this function has no team writer role');
  if (!ASSISTANT_ID_PATTERN.test(binding.assistant)) throw new TeamWriterRefused(`'${binding.assistant}' is not an assistant id`);
  if (binding.alt !== undefined && !ALT_NAME_PATTERN.test(binding.alt)) throw new TeamWriterRefused(`'${binding.alt}' is not an alt's name`);
  const key = `${roleArn}|${binding.assistant}|${binding.alt ?? ''}`;
  const cached = sessions.get(key);
  if (cached?.expiration && cached.expiration.getTime() - REFRESH_MARGIN_MS > Date.now()) return cached;
  sts ??= new STSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const res = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: `team-${binding.assistant}`.slice(0, 64),
    DurationSeconds: 900,
    Tags: [
      { Key: TEAM_WRITER_TAG.assistant, Value: binding.assistant },
      ...(binding.alt ? [{ Key: TEAM_WRITER_TAG.alt, Value: binding.alt }] : []),
    ],
  }));
  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new TeamWriterRefused('STS returned no credentials');
  const credentials: AwsCredentialIdentity = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    ...(c.Expiration ? { expiration: new Date(c.Expiration) } : {}),
  };
  sessions.set(key, credentials);
  return credentials;
};

/** Forget cached sessions and the STS client. For tests. */
export function _resetTeamWriterSessions(): void {
  sessions.clear();
  sts = null;
}
