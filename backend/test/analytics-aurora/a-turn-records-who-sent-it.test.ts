/**
 * A TURN RECORDS WHO SENT IT, ON AN AXIS THAT IS NOT CLASSIFICATION.
 *
 * ── THE STATE THIS REPLACES, MEASURED LIVE 2026-09-14 ───────────────────────────────────────────
 *
 * `exchanges.user_type` read 'unknown' on 198 of 200 rows. Not a data gap - the expression. A
 * person's message arrives from Amazon Chime SDK carrying no AE analytics metadata (AE attaches
 * metadata to messages it WRITES), so every producer-declared field on it is NULL by construction.
 * `user_type` is deprecated (migration 050) and no longer written.
 *
 * Filling a person-shaped column from the answering assistant is wrong, which is why it is pinned
 * against here: the column would say what served the turn, not anything about the sender.
 *
 * ── THE TWO AXES, WHICH THE SCHEMA KEEPS APART ──────────────────────────────────────────────────
 *
 *   CLASSIFICATION  what the conversation is (`conversation_classification`), what served it
 *                   (`agent_type`), what the caller was cleared for (`user_clearance`). Only a
 *                   producer that was there can declare these.
 *   ROLE            what KIND of principal sent it - person, admin plane, federated, assistant.
 *                   Structural, legible in the ARN, so archival can resolve it whenever it writes.
 *
 * That difference is the whole reason the role can be populated where the clearance cannot, and these
 * tests exist to stop the two being collapsed back together.
 */
import { classifyPrincipal } from '../../lambda/src/lib/principal-role';
import * as fs from 'fs';
import * as path from 'path';

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
const ADMIN = 'agent-echelon-admin';
const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', rel), 'utf8');

describe('the role of a principal comes off its ARN', () => {
  it('names each kind of sender', () => {
    const cases: [string, string][] = [
      [`${APP}/user/sub-123`, 'user'],
      [`${APP}/bot/premium-assistant`, 'bot'],
      [`${APP}/user/${ADMIN}`, 'admin'],
      // The two-identity split: a person's elevated identity is `${sub}-admin`, and a turn from it is
      // the admin PLANE acting, not that person chatting.
      [`${APP}/user/sub-123-admin`, 'admin'],
      // A person of another issuer is a person. Which issuer signed them in lives only in Identities, and
      // nothing reads it off the id.
      [`${APP}/user/fed_widget-7`, 'user'],
    ];
    for (const [arn, kind] of cases) {
      expect(`${arn.split('/').slice(-2).join('/')}: ${classifyPrincipal(arn, ADMIN).kind}`)
        .toBe(`${arn.split('/').slice(-2).join('/')}: ${kind}`);
    }
  });

  it("attributes an admin-plane twin's turn to the person who holds it, and the service admin to nobody", () => {
    const PERSON = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
    expect(classifyPrincipal(`${APP}/user/${PERSON}-admin`, ADMIN)).toEqual({ kind: 'admin', sub: `${PERSON}-admin`, owner: PERSON });
    expect(classifyPrincipal(`${APP}/user/${ADMIN}`, ADMIN).owner).toBeUndefined();
    // Archival files the row under the owner, so it is counted and erased with them.
    expect(src('analytics-aurora/kinesis-archival.ts')).toMatch(/person_id: isBot \? null : senderPersonKey\(/);
  });

  it('says unknown only when the ARN names no principal, never as a default', () => {
    expect(classifyPrincipal(undefined, ADMIN).kind).toBe('unknown');
    expect(classifyPrincipal(`${APP}/user/`, ADMIN).kind).toBe('unknown');
    // A real sender never lands there, which is what makes the value worth chasing when it appears.
    expect(classifyPrincipal(`${APP}/user/anybody`, ADMIN).kind).toBe('user');
  });

  it('is ONE definition, shared with the membership audit', () => {
    // The audit had this taxonomy and was the only thing that knew it. A second copy in archival
    // would be two principal taxonomies free to disagree - the exact drift the classification work
    // spent this session removing from the raw Lambdas.
    const audit = src('membership-audit.ts');
    expect(`audit imports it: ${audit.includes("from './lib/principal-role.js'")}`)
      .toBe('audit imports it: true');
    expect(`audit re-implements it: ${/classifyMember[\s\S]{0,400}startsWith\('fed_'\)/.test(audit)}`)
      .toBe('audit re-implements it: false');

    const archival = src('analytics-aurora/kinesis-archival.ts');
    expect(`archival imports it: ${archival.includes("principal-role.js")}`)
      .toBe('archival imports it: true');
  });
});

describe('archival keeps the role axis apart from the classification axis', () => {
  const archival = () => src('analytics-aurora/kinesis-archival.ts');

  it('stamps the role from the sender ARN, not from anything declared', () => {
    // Derived, because a person's message declares nothing - that is the entire point.
    expect(archival()).toMatch(/user_role: classifyPrincipal\(senderArn/);
  });

  it('never writes the deprecated user_type column', () => {
    const s = archival();
    // Migration 050: the column stays for old rows and nothing mints a value into it. Every insert
    // column list names the conversation's classification instead.
    const namingIt = s.match(/INSERT INTO (messages|exchanges|conversations)\s*\([^)]*\buser_type\b/g) || [];
    expect(`inserts naming user_type: ${namingIt.length}`).toBe('inserts naming user_type: 0');
    expect(s).not.toMatch(/'user_type',/);
    // Non-vacuity: the same shape does find the column that replaced it.
    const namingNew = s.match(/INSERT INTO (messages|exchanges|conversations)\s*\([^)]*\bconversation_classification\b/g) || [];
    expect(namingNew.length).toBeGreaterThanOrEqual(3);
  });

  it('never fills the conversation classification from the answering assistant', () => {
    const s = archival();
    // agent_type is the assistant's own classification; the room's comes from what the turn declared.
    const reachesAgent = /COALESCE\([^)]*conversation_classification[^)]*assistant/.test(s);
    expect(`falls back to assistant: ${reachesAgent}`).toBe('falls back to assistant: false');
    expect(s).toMatch(/COALESCE\(am_upd\.conversation_classification, am\.conversation_classification, c\.conversation_classification\)/);
  });

  it('carries the role onto the exchange from BOTH pairing paths', () => {
    const s = archival();
    // Two inserts mint exchanges - the in-batch pairer and the late database pairer - and the late
    // one mints most of them. A fix applied to one is the defect this file already documents once:
    // the in-batch path had the conversation fallback and the late path never learned it.
    const inserts = s.match(/INSERT INTO exchanges \(/g) || [];
    expect(`exchange inserts found: ${inserts.length >= 2}`).toBe('exchange inserts found: true');
    const roleCols = s.match(/channel_arn, conversation_classification, user_role, person_id, assistant/g) || [];
    expect(`inserts carrying user_role: ${roleCols.length}`).toBe(`inserts carrying user_role: ${inserts.length}`);
    const roleVals = s.match(/um\.user_role,/g) || [];
    expect(`inserts selecting it: ${roleVals.length}`).toBe(`inserts selecting it: ${inserts.length}`);
  });
});

describe('the column exists and says what it is for', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'schema',
      '049-what-kind-of-principal-sent-the-turn.sql'), 'utf8');

  it('is additive and idempotent, so a cold start can apply it', () => {
    expect(migration).toMatch(/ALTER TABLE messages\s+ADD COLUMN IF NOT EXISTS user_role/);
    expect(migration).toMatch(/ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS user_role/);
    expect(`drops anything: ${/DROP\s+(TABLE|COLUMN)/i.test(migration)}`).toBe('drops anything: false');
  });

  it('does not backfill, because a backfill is a deliberate act', () => {
    // The ARNs are still on the existing rows, so this CAN be backfilled later. Doing it inside a
    // migration makes a data rewrite a side effect of a deploy.
    expect(`updates existing rows: ${/^\s*UPDATE\s/mi.test(migration)}`).toBe('updates existing rows: false');
  });
});

describe('user_type is deprecated, not dropped (migration 050)', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'schema',
      '050-a-turn-records-the-conversation-classification.sql'), 'utf8');
  // Comments out, so the prose that explains what is NOT done cannot satisfy or trip a rule.
  const statements = migration.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('adds the conversation classification additively and idempotently', () => {
    for (const table of ['messages', 'exchanges', 'conversations']) {
      expect(statements).toMatch(new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS conversation_classification`));
    }
    expect(statements).not.toMatch(/CONCURRENTLY/i);
  });

  it('drops no table or column, rewrites no row, and only relaxes the old column', () => {
    expect(`drops anything: ${/DROP\s+(TABLE|COLUMN|INDEX|VIEW)/i.test(statements)}`).toBe('drops anything: false');
    expect(`updates existing rows: ${/^\s*(UPDATE|DELETE)\s/mi.test(statements)}`).toBe('updates existing rows: false');
    expect(statements).toMatch(/ALTER TABLE exchanges ALTER COLUMN user_type DROP NOT NULL/);
    expect(statements).toMatch(/COMMENT ON COLUMN exchanges\.user_type IS\s*'DEPRECATED/);
  });
});
