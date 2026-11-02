/**
 * THE `claims` DIRECTORY ADAPTER (C5): contact details for an issuer that has no directory of its own.
 *
 * An OIDC issuer a deployment trusts may offer nothing to look a person up in afterwards: the only time
 * this deployment learns their address is the verified token they sign in with. For such an issuer, and
 * only one that declares `directory: 'claims'` (`lib/config/issuers.ts`), the credential exchange keeps
 * the contact claims of the person's LAST sign-in, so a notification can still reach them.
 *
 * ── WHAT IS KEPT, AND FOR HOW LONG ────────────────────────────────────────────────────────────────
 *
 *  - One item per person and issuer in the user-profile table, keyed `<personId>#contact#<issuerId>`:
 *    the key names its owner (tenet D15), and never collides with the person's own profile item.
 *  - The claims (`email`, `name`) are ENCRYPTED WITH THE TABLE'S CUSTOMER MANAGED KEY before they are
 *    written, under an encryption context naming the person and the issuer, so only a principal granted
 *    `kms:Decrypt` on that key reads them. Only the directory's contact lookup is granted it
 *    (`grantDirectoryRead`, `lib/constructs/directory-access.ts`); the assistants that read the profile
 *    table see ciphertext.
 *  - REPLACED at each sign-in, and EXPIRED 90 days after the last one (`expiresAt`, the table's TTL).
 *    A read past the expiry answers nothing, whether or not DynamoDB has deleted the item yet.
 *  - ERASED WITH THE PERSON: offboarding deletes every copy (`contactCopies` in `OFFBOARDED_STORES`).
 *
 * The adapter answers by subject like every adapter, and never resolves identity: the core hands it the
 * person the subject already resolved to (`Directory`, `lib/membership-source.ts`). It has no address
 * search, so nobody is ever found here by email.
 */
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { personIdFromArn } from './person-arn.js';

type Sender = { send(command: unknown): Promise<any> };

/** How long a contact copy lives without a sign-in that replaces it. */
export const CONTACT_COPY_TTL_DAYS = 90;

/** The item key of one person's contact copy for one issuer. */
export function contactCopyKey(personId: string, issuerId: string): string {
  return `${personId}#contact#${issuerId}`;
}

/** The contact claims kept: an address and a display name. Nothing else a token carries. */
export interface ContactClaims {
  email: string | null;
  name: string | null;
}

/** Where the copies live. Either given directly (a reader) or resolved from SSM at run time (the exchange). */
export interface ContactCopyStore {
  doc: Sender;
  kms: Sender;
  table(): Promise<string>;
  keyArn(): Promise<string>;
  now?(): number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 254) : null);

const contextOf = (personId: string, issuerId: string) => ({ person: personId, issuer: issuerId });

/**
 * Replace the person's copy for this issuer with the contact claims of this sign-in, which the credential
 * exchange reads off the verified token (it is the only reader of a token). A sign-in carrying neither
 * claim deletes the copy, so an address the issuer has stopped sending is not kept.
 */
export async function writeContactCopy(
  args: { personId: string; issuerId: string; contact: { email?: unknown; name?: unknown } },
  store: ContactCopyStore,
): Promise<void> {
  const TableName = await store.table();
  const key = { personId: contactCopyKey(args.personId, args.issuerId) };
  const email = str(args.contact.email);
  const name = str(args.contact.name);
  const contact: ContactClaims | null = email || name ? { email, name } : null;
  if (!contact) {
    await store.doc.send(new DeleteCommand({ TableName, Key: key }));
    return;
  }
  const encrypted = await store.kms.send(new EncryptCommand({
    KeyId: await store.keyArn(),
    Plaintext: Buffer.from(JSON.stringify(contact), 'utf8'),
    EncryptionContext: contextOf(args.personId, args.issuerId),
  }));
  const now = store.now?.() ?? Date.now();
  await store.doc.send(new PutCommand({
    TableName,
    Item: {
      ...key,
      owner: args.personId,
      issuer: args.issuerId,
      contact: Buffer.from(encrypted.CiphertextBlob as Uint8Array).toString('base64'),
      updatedAt: new Date(now).toISOString(),
      expiresAt: Math.floor(now / 1000) + CONTACT_COPY_TTL_DAYS * 86_400,
    },
  }));
}

/** The person's copy for this issuer, decrypted, or null when there is none or it has expired. */
export async function readContactCopy(personId: string, issuerId: string, store: ContactCopyStore): Promise<ContactClaims | null> {
  const res = await store.doc.send(new GetCommand({ TableName: await store.table(), Key: { personId: contactCopyKey(personId, issuerId) } }));
  const item = res?.Item as { contact?: string; expiresAt?: number; owner?: string } | undefined;
  if (!item?.contact || item.owner !== personId) return null;
  const now = store.now?.() ?? Date.now();
  if (typeof item.expiresAt !== 'number' || item.expiresAt * 1000 <= now) return null;
  const plain = await store.kms.send(new DecryptCommand({
    CiphertextBlob: Buffer.from(item.contact, 'base64'),
    EncryptionContext: contextOf(personId, issuerId),
    KeyId: await store.keyArn(),
  }));
  const parsed = JSON.parse(Buffer.from(plain.Plaintext as Uint8Array).toString('utf8')) as Partial<ContactClaims>;
  return { email: str(parsed.email), name: str(parsed.name) };
}

/** Delete the person's copies for each issuer named. Returns how many existed. */
export async function eraseContactCopies(personId: string, issuerIds: readonly string[], doc: Sender, table: string): Promise<number> {
  let removed = 0;
  for (const issuerId of [...new Set(issuerIds)]) {
    const r = await doc.send(new DeleteCommand({ TableName: table, Key: { personId: contactCopyKey(personId, issuerId) }, ReturnValues: 'ALL_OLD' }));
    if (r?.Attributes) removed += 1;
  }
  return removed;
}

// ── THE ADAPTER ──────────────────────────────────────────────────────────────────────────────────

export interface ClaimsDirectory {
  readonly issuerId: string;
  /** The contact of the person a subject of this issuer resolved to. Throws when the store cannot be read. */
  contactOf(subject: string, personArn: string): Promise<ContactClaims | null>;
}

export function claimsDirectory(issuerId: string, store: ContactCopyStore = defaultContactCopyStore()): ClaimsDirectory {
  return {
    issuerId,
    async contactOf(_subject, personArn) {
      const personId = personIdFromArn(personArn);
      if (!personId) return null;
      return readContactCopy(personId, issuerId, store);
    },
  };
}

// ── THE DEPLOYED STORE ───────────────────────────────────────────────────────────────────────────

/**
 * The store as a function finds it: `CONTACT_COPY_TABLE` and `CONTACT_COPY_KEY_ARN` for a function the
 * table's stack wired, or the SSM parameters `CONTACT_COPY_TABLE_PARAM` and `CONTACT_COPY_KEY_PARAM` for
 * one in a stack deployed before it (the credential exchange). A parameter is read once and cached.
 */
let deployed: ContactCopyStore | null = null;
export function defaultContactCopyStore(): ContactCopyStore {
  if (deployed) return deployed;
  const region = process.env.AWS_REGION || 'us-east-1';
  const ssm = new SSMClient({ region });
  const cache = new Map<string, string>();
  const resolve = async (direct: string | undefined, param: string | undefined, what: string): Promise<string> => {
    if (direct) return direct;
    if (!param) throw new Error(`the contact copy ${what} is not configured`);
    const hit = cache.get(param);
    if (hit) return hit;
    const r = await ssm.send(new GetParameterCommand({ Name: param }));
    const value = r.Parameter?.Value || '';
    if (!value) throw new Error(`the contact copy ${what} parameter is empty`);
    cache.set(param, value);
    return value;
  };
  deployed = {
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } }),
    kms: new KMSClient({ region }),
    table: () => resolve(process.env.CONTACT_COPY_TABLE, process.env.CONTACT_COPY_TABLE_PARAM, 'table'),
    keyArn: () => resolve(process.env.CONTACT_COPY_KEY_ARN, process.env.CONTACT_COPY_KEY_PARAM, 'key'),
  };
  return deployed;
}

/** Test seam: replace the deployed store. `null` restores it. */
export function __setContactCopyStoreForTests(s: ContactCopyStore | null): void {
  deployed = s;
}
