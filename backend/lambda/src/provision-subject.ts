/**
 * THE SUBJECT PROVISIONER: `provisionSubject` as an operation one caller may invoke (P-13).
 *
 * A `provisioned-only` issuer (a `host-assertion` host, `lib/config/issuers.ts`) is never minted for. A
 * subject of one reaches only a person somebody pre-assigned it to, with a `pending` row in `Identities`
 * that the credential exchange binds once at that subject's first sign-in. This function writes those rows
 * and nothing else (`provisionSubject`, `lib/person-identity.ts`).
 *
 * ── ONE FUNCTION PER CALLER, AND THE CALLER IS THE FUNCTION'S OWN ─────────────────────────────────
 *
 * Two callers may provision, and nobody else: the admin backend (`AdminServices`, an administrator's
 * `POST /users/provision`) and the connector resolver (`Connectors`, a person a vendor names, V8). A direct
 * invoke attests nothing about its caller, so the caller is not read from the request. Each caller has its
 * own provisioner, built from this file with `PROVISION_CALLER` fixed at synth (`SubjectProvisioner`,
 * `lib/constructs/subject-provisioner.ts`), and each caller's role holds `lambda:InvokeFunction` on its own
 * provisioner alone. So the two layers are:
 *
 *  1. IAM. Only the caller's role may invoke its provisioner, and the provisioner's role may `PutItem` on
 *     `Identities` only under the keys of the issuers that caller may provision for
 *     (`dynamodb:LeadingKeys`), and only the attributes a `pending` row carries (`dynamodb:Attributes`).
 *  2. This handler. The issuer must be one this caller may provision for (`PROVISION_ISSUERS`) and one the
 *     registry declares `provisioned-only`; the row is created and never changed; a revoked subject is left
 *     revoked. The connector caller names no existing person: it pre-assigns a fresh one, and linking a
 *     subject to a person who already exists is an administrator's decision, recorded with who made it.
 *
 * A person pre-assigned this way reaches nothing until their first sign-in binds the row (V8).
 */
import { ChimeSDKIdentityClient, DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import { issuerById } from './lib/trusted-issuers.js';
import { isProvisionedOnly } from '../../lib/config/issuers.js';
import { adminTwinOwnerId, isPersonOf, personIdFromArn } from './lib/person-arn.js';
import { provisionSubject, type PersonIdentityDeps, type Provisioner } from './lib/person-identity.js';
import { chimeIdentityClient } from './lib/chime/clients.js';
// The deployment's set, read at runtime from the rows its stacks publish, before the handler runs.
import { withProfileRegistry } from '../../lib/profile-registry';

/** What a caller asks. `actor` is the administrator, for the record; the connector caller names its connector. */
export interface ProvisionRequest {
  op: 'provisionSubject';
  issuer: string;
  subject: string;
  /** Admin only: the AppInstanceUser the subject is linked to. Absent, a fresh person is pre-assigned. */
  appInstanceUserArn?: string;
  /** Who is provisioning: the administrator's person id (admin), or the connector id (connectors). */
  actor: string;
}

export type ProvisionAnswer =
  | { ok: true; state: 'provisioned'; personArn: string }
  | { ok: true; state: 'exists'; status: string }
  | { ok: false; code: 'INVALID_REQUEST' | 'ISSUER_NOT_PROVISIONABLE' | 'UNKNOWN_PERSON' | 'NOT_THIS_CALLER'; error: string };

export interface ProvisionDeps {
  caller: Provisioner | null;
  /** The issuer ids this caller may provision for, fixed at synth. */
  issuers: readonly string[];
  appInstanceArn: string;
  identity?: PersonIdentityDeps;
  /** True when the AppInstanceUser exists. */
  personExists?: (personArn: string) => Promise<boolean>;
}

const SUBJECT = /^[^\u0000-\u001f|]{1,256}$/;

const refuse = (code: Extract<ProvisionAnswer, { ok: false }>['code'], error: string): ProvisionAnswer => {
  console.warn('[ProvisionSubject][SecurityEvent] refused', { code });
  return { ok: false, code, error };
};

export async function handleProvision(raw: unknown, deps: ProvisionDeps): Promise<ProvisionAnswer> {
  const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProvisionRequest>;
  // NO CALLER CONFIGURED IS NO CALLER: a provisioner built without one writes nothing.
  if (deps.caller !== 'admin' && deps.caller !== 'connectors') return refuse('NOT_THIS_CALLER', 'this provisioner serves no caller');
  if (req.op !== 'provisionSubject') return refuse('INVALID_REQUEST', 'the operation is provisionSubject');
  const issuerId = typeof req.issuer === 'string' ? req.issuer : '';
  const subject = typeof req.subject === 'string' ? req.subject : '';
  const actor = typeof req.actor === 'string' ? req.actor.trim() : '';
  if (!issuerId || !SUBJECT.test(subject) || !actor) return refuse('INVALID_REQUEST', 'an issuer, a subject and an actor are required');

  // THE ISSUER: one this caller may provision for, and one the registry declares provisioned-only.
  const issuer = issuerById(issuerId);
  if (!deps.issuers.includes(issuerId) || !issuer || !isProvisionedOnly(issuer)) {
    return refuse('ISSUER_NOT_PROVISIONABLE', `"${issuerId}" is not a provisioned-only issuer this caller provisions for`);
  }

  // A LINK TO A PERSON WHO EXISTS IS AN ADMINISTRATOR'S DECISION.
  let personArn: string | undefined;
  if (req.appInstanceUserArn !== undefined) {
    if (deps.caller !== 'admin') return refuse('NOT_THIS_CALLER', 'a connector pre-assigns a new person and never links an existing one');
    const arn = String(req.appInstanceUserArn);
    const id = personIdFromArn(arn);
    if (!id || !isPersonOf(arn, deps.appInstanceArn) || adminTwinOwnerId(id)) {
      return refuse('INVALID_REQUEST', 'appInstanceUserArn names a person of this app instance');
    }
    if (!(await (deps.personExists ?? describedPersonExists)(arn))) return refuse('UNKNOWN_PERSON', 'no such person');
    personArn = arn;
  }

  const result = await provisionSubject(
    { issuer: issuerId, subject, ...(personArn ? { personArn } : {}), provisionedBy: deps.caller },
    { ...deps.identity, actor: `${deps.caller}:${actor}`.slice(0, 200) },
  );
  return result.state === 'provisioned'
    ? { ok: true, state: 'provisioned', personArn: result.personArn }
    : { ok: true, state: 'exists', status: result.status };
}

let chime: ChimeSDKIdentityClient | null = null;
async function describedPersonExists(personArn: string): Promise<boolean> {
  chime ??= chimeIdentityClient({ region: process.env.AWS_REGION || 'us-east-1' });
  try {
    await chime.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: personArn }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'NotFoundException') return false;
    throw err;
  }
}

function issuersFromEnv(): string[] {
  try {
    const parsed = JSON.parse(process.env.PROVISION_ISSUERS || '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export const handler = withProfileRegistry((event: unknown): Promise<ProvisionAnswer> => {
  const caller = process.env.PROVISION_CALLER;
  return handleProvision(event, {
    caller: caller === 'admin' || caller === 'connectors' ? caller : null,
    issuers: issuersFromEnv(),
    appInstanceArn: process.env.APP_INSTANCE_ARN || '',
  });
});
