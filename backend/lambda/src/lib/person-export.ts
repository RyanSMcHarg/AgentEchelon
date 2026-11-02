/**
 * EXPORT BY APPINSTANCEUSER (B13, GDPR Articles 15 and 20): one archive of everything the platform keeps
 * about a person, read from the SAME per-store inventory erasure uses (SPEC-CREDENTIAL-EXCHANGE §5b, plan §5.2).
 *
 * ── ONE INVENTORY, TWO READERS ───────────────────────────────────────────────────────────────────────
 *
 * Erasure walks `OFFBOARDED_STORES` and names what it keeps in `OFFBOARDING_KEPT` (`lib/offboarding.ts`).
 * This walks the same two lists, and its reader table is typed by them (`EXPORT_READERS`), so a store added
 * to erasure without a reader here fails the build, and the archive names every store the inventory names,
 * in its order. It runs on the offboarding function and role (Identity), which already find a person's
 * records in every store; the console asks for it through user management (`POST /users/export`) exactly as
 * it asks for a delete, so the admin backend reads no store of its own.
 *
 * ── WHAT A SECTION SAYS ──────────────────────────────────────────────────────────────────────────────
 *
 * Each store is one section: `held` when the deployment keeps the store and something about the person is in
 * it, its rows, and, where only a listing is exported, why. A store this deployment has not deployed is
 * `deployed: false`. A store whose export is not built says so (`notBuilt`), so the archive never reads as
 * complete where it is not:
 *  - attachments are listed by key and size, not copied: the bytes are reached through the console's audited,
 *    per-conversation attachment read, and an archive inlining them could pass Lambda's response limit;
 *  - a connector grant is a vendor credential and is never exported; that the person holds one is
 *    **NOT BUILT** here (the grant store is the Connectors stack's);
 *  - battle votes, thumbs feedback and the conversation archive are kept at erasure; reading them into the
 *    archive is **NOT BUILT** (they live in the Battle stack, Conversations' feedback table, and the archive's
 *    query surface, none of which this role reads).
 *
 * No token is exported usable: a token record holds only its hash, and the hash is dropped too.
 */
import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import { ListTagsForResourceCommand as ListChannelTagsCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  OFFBOARDED_STORES, OFFBOARDING_KEPT, PERSON_TOKEN_KINDS, BUDGET_ROW_HORIZON_HOURS, USER_TASKS_BY_OWNER, agentTaskFilter, channelContextFilter,
  channelsOf, exists, memberIdentityNamesPerson, poolIssuerIds, rowsOfPerson, twinOf,
  type MemberIdentityEntry, type OffboardedStore, type OffboardingActor, type OffboardingDeps, type PersonStores,
} from './offboarding.js';
import { adminTwinIdFor, adminTwinOwnerId, appInstanceArnOf, personIdFromArn, userArnFor } from './person-arn.js';
import { parseIssuerSubjectKey, type IdentityRow } from './person-identity.js';
import { contactCopyKey } from './claims-directory.js';
import { noticePreferencesKey } from './notice-preferences.js';
import { trustedIssuers } from './trusted-issuers.js';
import { UPGRADE_SOURCE_PERSON_TAG, UPGRADE_SOURCE_TAG } from './upgrade.js';
import { everyChannelMessage } from './chime/history.js';
import { hourKeyAt, userBudgetKey } from './abuse-control-keys.js';
import { mapBounded } from './bounded-map.js';
import { appendServerEvent } from './event-archive.js';

type Sender = { send(command: unknown): Promise<any> };
export type KeptStore = (typeof OFFBOARDING_KEPT)[number];
export type ExportedStore = OffboardedStore | KeptStore;

/** One store's part of the archive. */
export interface ExportSection {
  store: ExportedStore;
  /** False when this deployment has not deployed the store. */
  deployed: boolean;
  /** True when something about the person is in it. */
  held: boolean;
  /** What erasure does with it: removes it, or keeps it. */
  atErasure: 'erased' | 'kept';
  rows: unknown[];
  /** How the rows are exported, where that is less than the rows themselves. */
  note?: string;
  /** Why the store's export is not built, when it is not. */
  notBuilt?: string;
}

/** The whole archive. */
export interface PersonExport {
  format: 'agentechelon-person-export';
  version: 1;
  personArn: string;
  exportedAt: string;
  /** Every store of the inventory, in its order: erased ones, then kept ones. */
  sections: ExportSection[];
}

interface ReadContext {
  personArn: string;
  personId: string;
  deps: OffboardingDeps;
  stores: PersonStores;
  rows: IdentityRow[];
  personExists: boolean;
  bearer: string | null;
}

type Reader = (c: ReadContext) => Promise<Omit<ExportSection, 'store' | 'atErasure'>>;

const section = (rows: unknown[], extra: Partial<ExportSection> = {}) => ({ deployed: true, held: rows.length > 0, rows, ...extra });
const absent = () => ({ deployed: false, held: false, rows: [] as unknown[] });

async function getItem(doc: Sender, table: string, key: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return ((await doc.send(new GetCommand({ TableName: table, Key: key })))?.Item as Record<string, unknown> | undefined) ?? null;
}

async function queryAll(doc: Sender, input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({ ...input, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) } as never));
    out.push(...((r?.Items || []) as Record<string, unknown>[]));
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function scanAll(doc: Sender, input: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new ScanCommand({ ...input, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) } as never));
    out.push(...((r?.Items || []) as Record<string, unknown>[]));
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * THE READERS, ONE PER STORE OF THE INVENTORY. Typed by the inventory itself, so a store erasure gains without
 * a reader here is a compile error, not a silent hole in a person's archive.
 */
export const EXPORT_READERS: Readonly<Record<ExportedStore, Reader>> = {
  async adminTwin(c) {
    const twinArn = userArnFor(c.deps.appInstanceArn, adminTwinIdFor(c.personId));
    const has = await twinOf(c.deps.chime, twinArn, c.personArn);
    return section(has ? [{ appInstanceUserArn: twinArn }] : []);
  },
  async upgradeSources(c) {
    if (!c.personExists || !c.bearer) return section([]);
    const rows: unknown[] = [];
    for (const channelArn of await channelsOf(c.personArn, c.bearer, c.deps)) {
      const tags = (await c.deps.messaging.send(new ListChannelTagsCommand({ ResourceARN: channelArn })))?.Tags as Array<{ Key?: string; Value?: string }> | undefined;
      const source = tags?.find((t) => t.Key === UPGRADE_SOURCE_TAG)?.Value;
      if (!source || appInstanceArnOf(source) !== c.deps.appInstanceArn) continue;
      const visitor = tags?.find((t) => t.Key === UPGRADE_SOURCE_PERSON_TAG)?.Value;
      const senders = new Set([c.personArn, ...(visitor ? [visitor] : [])]);
      let messages: unknown[] = [];
      try {
        messages = (await everyChannelMessage(c.deps.messaging, source, c.bearer))
          .filter((m) => senders.has(m.Sender?.Arn ?? ''))
          .map((m) => ({ messageId: m.MessageId, sentAt: m.CreatedTimestamp, sender: m.Sender?.Arn, content: m.Content }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'NotFoundException') throw err;
      }
      rows.push({ conversation: channelArn, visitorConversation: source, messages });
    }
    return section(rows);
  },
  async memberships(c) {
    if (!c.personExists || !c.bearer) return section([]);
    return section((await channelsOf(c.personArn, c.bearer, c.deps)).map((channelArn) => ({ channelArn })), {
      note: 'Each conversation the person is a member of. Its messages are the conversation\'s, read in the app while it lasts and kept by the archive.',
    });
  },
  async userProfile(c) {
    if (!c.stores.userProfile) return absent();
    const item = await getItem(c.deps.doc, c.stores.userProfile, { personId: c.personId });
    return section(item ? [item] : []);
  },
  async contactCopies(c) {
    if (!c.stores.userProfile) return absent();
    const issuerIds = [...new Set([...c.rows.map((r) => r.issuer), ...trustedIssuers().filter((t) => t.directory === 'claims').map((t) => t.id)])];
    const rows: unknown[] = [];
    for (const issuerId of issuerIds) {
      const item = await getItem(c.deps.doc, c.stores.userProfile, { personId: contactCopyKey(c.personId, issuerId) });
      if (item) rows.push({ issuer: issuerId, ...item });
    }
    return section(rows);
  },
  async noticePreferences(c) {
    if (!c.stores.userProfile) return absent();
    const item = await getItem(c.deps.doc, c.stores.userProfile, { personId: noticePreferencesKey(c.personId) });
    return section(item ? [item] : []);
  },
  async userTasks(c) {
    if (!c.stores.userTasks) return absent();
    const values = { ':p': c.personId };
    const [held, owned] = await Promise.all([
      queryAll(c.deps.doc, { TableName: c.stores.userTasks, KeyConditionExpression: 'principalId = :p', ExpressionAttributeValues: values }),
      queryAll(c.deps.doc, { TableName: c.stores.userTasks, IndexName: USER_TASKS_BY_OWNER, KeyConditionExpression: 'ownerPersonId = :p', ExpressionAttributeValues: values }),
    ]);
    const rows = new Map<string, Record<string, unknown>>();
    for (const r of [...held, ...owned]) rows.set(`${String(r.principalId)}#${String(r.taskId)}`, r);
    return section([...rows.values()]);
  },
  async agentTasks(c) {
    if (!c.stores.agentTasks) return absent();
    return section(await scanAll(c.deps.doc, { TableName: c.stores.agentTasks, ...agentTaskFilter(c.personArn, c.personId) }));
  },
  async channelContext(c) {
    if (!c.stores.channelContext) return absent();
    const subjects = c.rows.map((r) => parseIssuerSubjectKey(r.issuerSubject)).filter(Boolean) as Array<{ issuer: string; subject: string }>;
    const rows: unknown[] = [];
    for (const item of await scanAll(c.deps.doc, { TableName: c.stores.channelContext, ...channelContextFilter(c.personId), ProjectionExpression: 'channelArn, #m, #i' })) {
      const entries = (Array.isArray(item.memberIdentities) ? item.memberIdentities as MemberIdentityEntry[] : [])
        .filter((e) => memberIdentityNamesPerson(e, c.personId, subjects));
      const intake = (item.onboardingIntake as { subject?: string } | undefined)?.subject === c.personId ? item.onboardingIntake : undefined;
      if (entries.length || intake) rows.push({ channelArn: item.channelArn, ...(entries.length ? { memberIdentities: entries } : {}), ...(intake ? { onboardingIntake: intake } : {}) });
    }
    return section(rows);
  },
  async battleConfig(c) {
    if (!c.stores.battleConfig) return absent();
    return section(await scanAll(c.deps.doc, {
      TableName: c.stores.battleConfig, FilterExpression: 'enabledBy = :arn', ExpressionAttributeValues: { ':arn': c.personArn },
      ProjectionExpression: 'channelArn, enabledBy, enabledAt',
    }), { note: 'Each conversation whose battle setting the person enabled. The setting is the conversation\'s; erasure removes only the person\'s name from it.' });
  },
  async auroraProjection(c) {
    if (!c.deps.auroraProjection) return absent();
    return { deployed: true, held: false, rows: [], notBuilt: 'The person\'s own rows in the Aurora projection are erased with them; reading them into this archive is NOT BUILT.' };
  },
  async turnState(c) {
    if (!c.stores.turnState) return absent();
    return section(await scanAll(c.deps.doc, {
      TableName: c.stores.turnState,
      FilterExpression: 'begins_with(pk, :stop) AND contains(pk, :person)',
      ExpressionAttributeValues: { ':stop': 'stop#', ':person': `#${c.personId}#` },
    }));
  },
  async budgetRows(c) {
    if (!c.stores.abuseControls) return absent();
    const now = c.deps.now?.() ?? new Date();
    const hours = Array.from({ length: BUDGET_ROW_HORIZON_HOURS + 1 }, (_, h) => hourKeyAt(new Date(now.getTime() - h * 3_600_000)));
    const items = await mapBounded(hours, 8, (hour) => getItem(c.deps.doc, c.stores.abuseControls!, { pk: userBudgetKey(c.personId, hour) }));
    return section(items.filter(Boolean) as unknown[]);
  },
  async attachments(c) {
    if (!c.stores.attachmentsBucket) return absent();
    const conversations: string[] = [];
    let ContinuationToken: string | undefined;
    do {
      const page = await c.deps.s3.send(new ListObjectsV2Command({ Bucket: c.stores.attachmentsBucket, Prefix: 'attachments/', Delimiter: '/', ContinuationToken }));
      for (const p of page?.CommonPrefixes || []) if (p.Prefix) conversations.push(p.Prefix);
      ContinuationToken = page?.NextContinuationToken;
    } while (ContinuationToken);
    const rows: unknown[] = [];
    await mapBounded(conversations, 8, async (conversation) => {
      let token: string | undefined;
      do {
        const page = await c.deps.s3.send(new ListObjectsV2Command({ Bucket: c.stores.attachmentsBucket, Prefix: `${conversation}${c.personId}/`, ContinuationToken: token }));
        for (const o of page?.Contents || []) rows.push({ key: o.Key, size: o.Size, lastModified: o.LastModified });
        token = page?.NextContinuationToken;
      } while (token);
    });
    return section(rows, { note: 'Listed by key and size. The files themselves are read through the audited, per-conversation attachment read.' });
  },
  async connectorGrants() {
    return { deployed: true, held: false, rows: [], notBuilt: 'Whether the person holds a connector grant is the Connectors stack\'s to list, and that listing is NOT BUILT; a grant itself is a vendor credential and is never exported.' };
  },
  async personTokens(c) {
    if (!c.stores.tokens) return absent();
    const kinds = Object.fromEntries(PERSON_TOKEN_KINDS.map((k, i) => [`:k${i}`, k]));
    const items = await scanAll(c.deps.doc, {
      TableName: c.stores.tokens,
      FilterExpression: `(personArn = :person OR inviterArn = :person) AND #k IN (${Object.keys(kinds).join(', ')})`,
      ExpressionAttributeNames: { '#k': 'kind' },
      ExpressionAttributeValues: { ':person': c.personArn, ...kinds },
    });
    // NO TOKEN, AND NOT ITS HASH: what the record says, never what would find it.
    return section(items.map(({ pk: _pk, ...rest }) => rest));
  },
  async identities(c) {
    return section(c.rows.map((r) => {
      const parsed = parseIssuerSubjectKey(r.issuerSubject);
      return { issuer: parsed?.issuer, subject: parsed?.subject, status: r.status ?? 'active', ...(r.createdAt ? { createdAt: r.createdAt } : {}) };
    }));
  },
  async appInstanceUser(c) {
    if (!c.personExists) return section([]);
    const u = (await c.deps.chime.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: c.personArn })))?.AppInstanceUser;
    return section(u ? [{ appInstanceUserArn: u.AppInstanceUserArn, name: u.Name, createdAt: u.CreatedTimestamp, expiration: u.ExpirationSettings ?? null }] : []);
  },
  async poolAccount(c) {
    const rows: unknown[] = [];
    for (const r of c.rows) {
      const parsed = parseIssuerSubjectKey(r.issuerSubject);
      if (!parsed || !poolIssuerIds(c.deps.primary).includes(parsed.issuer)) continue;
      const record = await c.deps.primary.record(parsed.subject);
      if (record) rows.push({ username: record.username, email: record.email, name: record.name, status: record.status, enabled: record.enabled, createdAt: record.createdAt, attributes: record.attributes });
    }
    return section(rows);
  },
  async battle_votes() {
    return { deployed: true, held: false, rows: [], notBuilt: 'Battle votes are kept at erasure and carry the person\'s id; reading them into this archive is NOT BUILT.' };
  },
  async feedback() {
    return { deployed: true, held: false, rows: [], notBuilt: 'Thumbs feedback is kept at erasure and carries the person\'s id; reading it into this archive is NOT BUILT.' };
  },
  async archive() {
    return { deployed: true, held: false, rows: [], notBuilt: 'The conversation archive (message events, client events, the offboarding and export records) is kept until it expires; reading the person\'s events into this archive is NOT BUILT.' };
  },
};

/** Export one AppInstanceUser. Throws for an id that is not a person of this app instance. */
export async function exportPerson(personArn: string, actor: OffboardingActor, deps: OffboardingDeps): Promise<{ found: boolean; archive: PersonExport }> {
  const personId = personIdFromArn(personArn);
  if (!personId || appInstanceArnOf(personArn) !== deps.appInstanceArn || adminTwinOwnerId(personId)) {
    throw new Error('export: not a person of this app instance');
  }
  const rows = await rowsOfPerson(personArn, deps);
  const personExists = await exists(deps.chime, personArn);
  const stores = await deps.stores();
  const bearer = personExists ? await deps.adminBearer() : null;
  const ctx: ReadContext = { personArn, personId, deps, stores, rows, personExists, bearer };
  const sections: ExportSection[] = [];
  for (const store of [...OFFBOARDED_STORES, ...OFFBOARDING_KEPT] as ExportedStore[]) {
    const read = await EXPORT_READERS[store](ctx);
    sections.push({ store, atErasure: (OFFBOARDING_KEPT as readonly string[]).includes(store) ? 'kept' : 'erased', ...read });
  }
  const archive: PersonExport = {
    format: 'agentechelon-person-export', version: 1, personArn, exportedAt: (deps.now?.() ?? new Date()).toISOString(), sections,
  };
  const found = personExists || rows.length > 0 || sections.some((s) => s.held);
  if (found) {
    // ONE RECORD OF THE EXPORT, with who asked and what each store held, never the content.
    try {
      await appendServerEvent({
        eventType: 'export',
        personId,
        properties: { actorArn: actor.arn, personArn, ...Object.fromEntries(sections.map((s) => [`held_${s.store}`, s.rows.length])) },
      });
    } catch (err) {
      console.error('[Export][SecurityEvent] the export could not be recorded in the archive', { personArn, err: (err as Error)?.name });
    }
  }
  return { found, archive };
}
