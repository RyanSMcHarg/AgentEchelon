/**
 * WHAT THE PERSON HAS NOT SENT YET IS KEPT ON THIS DEVICE: the draft of each conversation (its text and the members it
 * picked, by id), the file staged with it, and every message on its way out. A refused send, a reload, a dropped
 * connection or an offline spell loses none of it.
 *
 * - Scoped by person: every record is keyed by the signed-in person's AppInstanceUser id, and the whole cache is cleared
 *   when the person signs out (`onSessionEnd` with `signed-out`), so another person signing in on this browser never sees
 *   it. A write carries the session it was made in and is dropped once that session has ended, so nothing is written back
 *   after the clear. A session that ended without a sign-out (a refused refresh, an expired token, a closed browser)
 *   leaves its records, since another window of the browser may still be signed in and sending from them; a sign-in
 *   removes every record and staged file that is not the signed-in person's (`keepOnlyPersonsComposerCache`).
 * - Drafts and the outbox live in `localStorage`, which holds text; a staged file's bytes live in IndexedDB, up to
 *   `STAGED_FILE_CAP_BYTES` each and `STAGED_FILES_TOTAL_CAP_BYTES` across the person's conversations, the oldest staged
 *   file's bytes let go first. A larger file, one let go, or a browser that keeps no IndexedDB, keeps the file's name, so
 *   the person is asked to attach it again.
 * - Every storage access is guarded: a browser that refuses storage (private mode, a full quota) keeps working, with
 *   nothing kept.
 */
import type { ComposerDraft, DraftMention } from '../utils/composerMentions';
import { currentSessionEpoch, onSessionEnd } from '@ae/shared/services/sessionEpoch.ts';

const PREFIX = 'ae.composer.v1.';

/** The largest staged file kept on this device; a larger one keeps its name only. */
export const STAGED_FILE_CAP_BYTES = 10 * 1024 * 1024;

/** The most staged files' bytes kept on this device across a person's conversations; the oldest are let go first. */
export const STAGED_FILES_TOTAL_CAP_BYTES = 50 * 1024 * 1024;

/** A staged file as the cache records it. `kept` says its bytes are on this device. */
export interface StagedFileRecord {
  name: string;
  size: number;
  type: string;
  kept: boolean;
}

/** A conversation's unsent draft, with the file staged beside it. */
export interface CachedDraft {
  draft: ComposerDraft;
  file?: StagedFileRecord;
}

/** What a send asks of the service beside its text. */
export interface OutboxSendOptions {
  targetArn?: string;
  mentionBotArn?: string;
  mentionArns?: string[];
}

/**
 * A message on its way out: written before the send and removed on the service's confirmation. `id` is the message's
 * client id, sent as its idempotency token and in its Metadata, so a retry after an unknown outcome posts it once.
 */
export interface OutboxEntry {
  id: string;
  conversationId: string;
  channelArn: string;
  /** The text as sent: each picked member as its token. */
  content: string;
  metadata?: Record<string, unknown>;
  options?: OutboxSendOptions;
  createdAt: number;
  /** A send was started, so the service may hold it already. */
  attempted?: boolean;
  /** The service refused it; it waits for the person to retry or discard it. */
  failed?: string;
}

/** The session a write belongs to: capture it before the work, pass it to the write. */
export function cacheSession(): number {
  return currentSessionEpoch();
}

const live = (session: number) => session === currentSessionEpoch();

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** Keep `value` under `key`. Answers whether it was kept: false where the browser refused it or keeps no storage. */
function writeJson(key: string, value: unknown): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    /* storage refused: nothing is kept */
    return false;
  }
}

function removeKey(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* storage refused */
  }
}

const draftKey = (personId: string, conversationId: string) => `${PREFIX}draft.${personId}.${conversationId}`;
const outboxKey = (personId: string) => `${PREFIX}outbox.${personId}`;
const fileKey = (personId: string, conversationId: string) => `${personId}.${conversationId}`;
const filesIndexKey = (personId: string) => `${PREFIX}files.${personId}`;

/** Each staged file whose bytes are kept, by conversation: its size and when it was kept. */
type FilesIndex = Record<string, { size: number; at: number }>;

function readFilesIndex(personId: string): FilesIndex {
  const value = readJson(filesIndexKey(personId));
  const out: FilesIndex = {};
  if (value && typeof value === 'object') {
    for (const [c, v] of Object.entries(value as Record<string, unknown>)) {
      const e = v as { size?: unknown; at?: unknown };
      if (typeof e?.size === 'number' && typeof e.at === 'number') out[c] = { size: e.size, at: e.at };
    }
  }
  return out;
}

function writeFilesIndex(personId: string, index: FilesIndex): void {
  if (Object.keys(index).length) writeJson(filesIndexKey(personId), index);
  else removeKey(filesIndexKey(personId));
}

/** Whether a record key of this cache is the person's own. An id may hold dots, so it is matched by the key's whole shape. */
function isPersonsKey(key: string, personId: string): boolean {
  return key === outboxKey(personId) || key === filesIndexKey(personId) || key.startsWith(`${PREFIX}draft.${personId}.`);
}

function isMention(value: unknown): value is DraftMention {
  const m = value as DraftMention;
  return !!m && typeof m.start === 'number' && typeof m.end === 'number' && typeof m.token === 'string' && m.start < m.end;
}

function isFileRecord(value: unknown): value is StagedFileRecord {
  const f = value as StagedFileRecord;
  return !!f && typeof f.name === 'string' && typeof f.size === 'number' && typeof f.type === 'string' && typeof f.kept === 'boolean';
}

/** The conversation's cached draft, or undefined. A record whose picks no longer fit its text is read as text alone. */
export function readDraft(personId: string, conversationId: string): CachedDraft | undefined {
  const value = readJson(draftKey(personId, conversationId)) as { draft?: { text?: unknown; mentions?: unknown }; file?: unknown } | undefined;
  if (!value || typeof value.draft?.text !== 'string') return undefined;
  const text = value.draft.text;
  const mentions = Array.isArray(value.draft.mentions) && value.draft.mentions.every(isMention)
    && value.draft.mentions.every((m) => m.end <= text.length)
    ? value.draft.mentions as DraftMention[]
    : [];
  return { draft: { text, mentions }, ...(isFileRecord(value.file) ? { file: value.file } : {}) };
}

/** Keep the conversation's draft, or forget it when there is nothing left to keep. */
export function writeDraft(personId: string, conversationId: string, value: CachedDraft, session: number): void {
  if (!live(session)) return;
  if (!value.draft.text && !value.file) removeKey(draftKey(personId, conversationId));
  else writeJson(draftKey(personId, conversationId), value);
}

/** Where a staged file's bytes are kept. */
export interface BlobStore {
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | undefined>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Every key held, where the store can list them. */
  keys?(): Promise<string[]>;
}

const DB_NAME = 'ae-composer';
const DB_STORE = 'staged-files';

function indexedDbBlobStore(): BlobStore | null {
  let idb: IDBFactory | undefined;
  try {
    idb = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  } catch {
    idb = undefined;
  }
  if (!idb) return null;
  const factory = idb;
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    opened.catch(() => { opened = null; });
    return opened;
  };
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction(DB_STORE, mode);
      const req = op(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    put: (key, blob) => run<void>('readwrite', (s) => s.put(blob, key)),
    get: (key) => run<Blob | undefined>('readonly', (s) => s.get(key)),
    delete: (key) => run<void>('readwrite', (s) => s.delete(key)),
    clear: () => run<void>('readwrite', (s) => s.clear()),
    keys: async () => (await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String),
  };
}

let blobStore: BlobStore | null | undefined;

function blobs(): BlobStore | null {
  if (blobStore === undefined) blobStore = indexedDbBlobStore();
  return blobStore;
}

/** Use `store` for staged files' bytes (null keeps none). For tests. */
export function setBlobStore(store: BlobStore | null): void {
  blobStore = store;
}

/** Keep a staged file: its bytes when within the cap and the browser keeps them, else its name alone. */
export async function keepStagedFile(personId: string, conversationId: string, file: File, session: number): Promise<StagedFileRecord> {
  const record = { name: file.name, size: file.size, type: file.type, kept: false };
  const store = blobs();
  if (!store || !live(session)) return record;
  try {
    if (file.size > STAGED_FILE_CAP_BYTES) {
      await store.delete(fileKey(personId, conversationId));
      dropFromFilesIndex(personId, conversationId);
      return record;
    }
    await store.put(fileKey(personId, conversationId), file);
    // A session that ended while the bytes were written leaves nothing behind.
    if (!live(session)) {
      await store.delete(fileKey(personId, conversationId));
      return record;
    }
    // Recorded at once, so a draft written with this record finds it; only a file let go waits on the store.
    for (const c of letGoBeyondTotalCap(personId, conversationId, file.size)) await store.delete(fileKey(personId, c));
    return { ...record, kept: true };
  } catch {
    return record;
  }
}

function dropFromFilesIndex(personId: string, conversationId: string): void {
  const index = readFilesIndex(personId);
  if (!(conversationId in index)) return;
  delete index[conversationId];
  writeFilesIndex(personId, index);
}

/**
 * THE PERSON'S STAGED FILES STAY WITHIN `STAGED_FILES_TOTAL_CAP_BYTES`: the file just kept is recorded, then the oldest
 * others are let go until the total fits, and their conversations are returned for their bytes to be deleted. A draft whose
 * file was let go keeps the file's name, marked not kept, so the person is asked to attach it again.
 */
function letGoBeyondTotalCap(personId: string, conversationId: string, size: number): string[] {
  const index = readFilesIndex(personId);
  index[conversationId] = { size, at: Date.now() };
  const oldestFirst = Object.entries(index).filter(([c]) => c !== conversationId).sort((a, b) => a[1].at - b[1].at);
  let total = Object.values(index).reduce((sum, e) => sum + e.size, 0);
  const letGo: string[] = [];
  for (const [c, e] of oldestFirst) {
    if (total <= STAGED_FILES_TOTAL_CAP_BYTES) break;
    letGo.push(c);
    delete index[c];
    total -= e.size;
    const draft = readDraft(personId, c);
    if (draft?.file?.kept) writeJson(draftKey(personId, c), { ...draft, file: { ...draft.file, kept: false } });
  }
  writeFilesIndex(personId, index);
  return letGo;
}

/** The staged file the record names, read back from this device, or undefined when its bytes were not kept. */
export async function restoreStagedFile(personId: string, conversationId: string, record: StagedFileRecord): Promise<File | undefined> {
  if (!record.kept) return undefined;
  try {
    const blob = await blobs()?.get(fileKey(personId, conversationId));
    if (!blob) return undefined;
    return new File([blob], record.name, { type: record.type || blob.type });
  } catch {
    return undefined;
  }
}

/** Forget the conversation's staged file. */
export async function forgetStagedFile(personId: string, conversationId: string): Promise<void> {
  try {
    await blobs()?.delete(fileKey(personId, conversationId));
    dropFromFilesIndex(personId, conversationId);
  } catch {
    /* storage refused */
  }
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  const e = value as OutboxEntry;
  return !!e && typeof e.id === 'string' && typeof e.channelArn === 'string' && typeof e.conversationId === 'string'
    && typeof e.content === 'string' && typeof e.createdAt === 'number';
}

/** The person's messages on their way out, oldest first. */
export function outboxEntries(personId: string): OutboxEntry[] {
  const value = readJson(outboxKey(personId));
  return Array.isArray(value) ? value.filter(isOutboxEntry).sort((a, b) => a.createdAt - b.createdAt) : [];
}

/**
 * Add an entry to the outbox, or replace the one with its id. Answers whether it is kept on this device: false where the
 * session has ended or the browser refused the write (a full quota, private mode), so a caller never says a message is
 * waiting to send when it is kept nowhere.
 */
export function putOutboxEntry(personId: string, entry: OutboxEntry, session: number): boolean {
  if (!live(session)) return false;
  const rest = outboxEntries(personId).filter((e) => e.id !== entry.id);
  return writeJson(outboxKey(personId), [...rest, entry]);
}

/** Remove an entry from the outbox. */
export function removeOutboxEntry(personId: string, id: string): void {
  const rest = outboxEntries(personId).filter((e) => e.id !== id);
  if (rest.length) writeJson(outboxKey(personId), rest);
  else removeKey(outboxKey(personId));
}

/**
 * A new client message id. The service's idempotency token allows letters, digits, `-` and `_` up to 64 characters,
 * which a UUID fits.
 */
export function newClientMessageId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Forget everything the cache holds, for every person. */
export async function clearComposerCache(): Promise<void> {
  const s = storage();
  try {
    if (s) {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(PREFIX)) keys.push(k);
      }
      for (const k of keys) s.removeItem(k);
    }
  } catch {
    /* storage refused */
  }
  try {
    await blobs()?.clear();
  } catch {
    /* storage refused */
  }
}

/**
 * KEEP ONLY THE SIGNED-IN PERSON'S RECORDS: every draft, outbox and staged file of anyone else on this browser is removed,
 * so what a session left behind without a sign-out does not outlive it into another person's.
 */
export async function keepOnlyPersonsComposerCache(personId: string): Promise<void> {
  if (!personId) return;
  const s = storage();
  const others: string[] = [];
  try {
    if (s) {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(PREFIX) && !isPersonsKey(k, personId)) others.push(k);
      }
    }
  } catch {
    /* storage refused */
  }
  const store = blobs();
  for (const k of others) {
    // Another person's staged files, by the index that names them, before the index itself goes.
    const other = k.startsWith(`${PREFIX}files.`) ? k.slice(`${PREFIX}files.`.length) : undefined;
    if (other && store) {
      for (const c of Object.keys(readFilesIndex(other))) {
        try { await store.delete(fileKey(other, c)); } catch { /* storage refused */ }
      }
    }
    removeKey(k);
  }
  // Any staged file the store holds that is not this person's, recorded in an index or not.
  try {
    const keys = (await store?.keys?.()) ?? [];
    for (const k of keys) if (!k.startsWith(`${personId}.`)) await store?.delete(k);
  } catch {
    /* storage refused */
  }
}

// A SIGN-OUT TAKES WHAT THE SESSION KEPT WITH IT. Any other end of a session leaves the records to the sign-in that
// follows, which keeps only its own person's.
onSessionEnd((reason) => { if (reason === 'signed-out') void clearComposerCache(); });
