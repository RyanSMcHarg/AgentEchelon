/**
 * A MESSAGE NOBODY ASKED FOR SAYS SO.
 *
 * `turn_kinds` reports what each assistant message IS, and an undeclared message falls into `answer`.
 * That bucket means "declared nothing", not "is an answer", and the console reads it as the latter.
 *
 * ── WHAT THAT HID ───────────────────────────────────────────────────────────
 *
 * Measured on live traffic: 348 messages counted as answers on one day against 120 exchanges. Most of
 * the bucket was messages nobody had paired and nobody was waiting on - welcomes above all, which fire
 * on the assistant joining a channel and answer nothing at all.
 *
 * Two things had to be true for a declaration to survive, and only one of them was:
 *
 *   1. The producer declares a kind. A welcome is RETURNED for Amazon Chime SDK to materialize, so
 *      there is no Metadata the handler controls and the CONTENT declaration is the only carrier.
 *   2. The parser accepts it. `TURN_KINDS` is an allowlist, so a kind missing from it is dropped -
 *      declaring it in content achieved nothing and the message still landed in `answer`.
 *
 * `notification` is the sharper case: `NoticeKind` has declared it in Metadata since 2026-09-21, and
 * the content carrier rejected the same word. One vocabulary in two places, disagreeing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TURN_KINDS } from '../lambda/src/lib/turn-declaration';

const SRC = path.join(__dirname, '..', 'lambda', 'src');
const router = fs.readFileSync(path.join(SRC, 'router-agent-handler.ts'), 'utf8');
const attribution = fs.readFileSync(path.join(SRC, 'lib', 'bot-message-attribution.ts'), 'utf8');

describe('the declarable kinds cover the messages that are not answers', () => {
  it('accepts welcome and notification, not only the two queue and drift kinds', () => {
    expect(TURN_KINDS).toContain('welcome');
    expect(TURN_KINDS).toContain('notification');
    // The originals stay: this widened the vocabulary, it did not replace it.
    expect(TURN_KINDS).toContain('reading');
    expect(TURN_KINDS).toContain('drift');
  });

  it('accepts every kind the Metadata carrier can declare', () => {
    // NoticeKind is the Metadata vocabulary and TURN_KINDS is the content one. A word in one and not
    // the other is a declaration that survives on a message the handler happens to own the Metadata
    // of and vanishes on one it does not - which is exactly how `notification` was lost.
    const noticeKinds = Array.from(attribution.matchAll(/^\s*\|\s*'([a-z-]+)'/gm)).map((m) => m[1]);
    expect(noticeKinds.length).toBeGreaterThan(0);
    for (const kind of noticeKinds) {
      // 'notice' and 'battle-notice' are Metadata-only today and are NOT required here; what must
      // hold is that a kind this repo asks the CONTENT carrier to accept is actually accepted.
      if (kind === 'notification') {
        expect(TURN_KINDS as readonly string[]).toContain(kind);
      }
    }
  });
});

describe('the welcome declares itself on both paths', () => {
  it('declares its kind on the ordinary welcome', () => {
    expect(router).toMatch(/withTurnDeclaration\(welcome\.content, \{ kind: 'welcome' \}\)/);
  });

  it('declares its kind on the drift-spawned welcome too, keeping its correlation marker', () => {
    // Two different claims on one message: the kind says what it is, the corr marker is how the
    // worker finds this placeholder. Losing either would break a different thing.
    const at = router.indexOf('const withMarker = withTurnDeclaration(');
    expect(at).toBeGreaterThan(-1);
    const stmt = router.slice(at, at + 320);
    expect(stmt).toContain('<!--corr:');
    expect(stmt).toContain("kind: 'welcome'");
  });

  it('declares in CONTENT, because a Lex-fulfilled message has no Metadata this handler owns', () => {
    // The welcome is returned for Amazon Chime SDK to materialize. Reaching for Metadata here would
    // compile and do nothing, which is the failure mode worth naming at the call site.
    const at = router.indexOf("withTurnDeclaration(welcome.content, { kind: 'welcome' })");
    const before = router.slice(Math.max(0, at - 700), at);
    expect(before).toMatch(/no Metadata this handler controls/i);
  });
});

describe('a declarable kind fits the column it lands in', () => {
  it('is shorter than messages.turn_kind', () => {
    // THE TRAP THIS EXISTS FOR is recorded next to TURN_ENTRIES: a declared value that overflows its
    // column fails the INSERT, and archival inserts inside a transaction - so one crafted or merely
    // long value aborts the whole Kinesis batch and it retries on the same poison record. A
    // declaration is content-carried and content reaches the model, so "nobody would write that" is
    // not an argument available here.
    const migration = fs.readFileSync(
      path.join(SRC, 'analytics-aurora', 'schema', '042-the-answer-names-what-it-answered.sql'),
      'utf8',
    );
    const width = Number(/turn_kind VARCHAR\((\d+)\)/.exec(migration)?.[1]);
    expect(Number.isFinite(width)).toBe(true);
    // The offenders are collected and asserted as a list, because jest's expect takes no message
    // argument - so a bare length comparison would fail with "13 is not <= 32" and not say which kind.
    const tooLong = TURN_KINDS.filter((kind) => kind.length > width);
    expect(tooLong).toEqual([]);
  });
});

describe('a join recap declares itself, so it is never paired with what preceded it', () => {
  it('is a declarable kind', () => {
    expect(TURN_KINDS).toContain('join_recap');
  });

  it("the router's placeholder declares it on a join recap's turn", () => {
    const at = router.indexOf('const placeholderContent = (body: string): string => withTurnDeclaration(');
    expect(at).toBeGreaterThan(-1);
    const before = router.slice(Math.max(0, at - 400), at + 300);
    expect(before).toMatch(/isJoinRecap\(event\) \? \{ kind: 'join_recap' as const \}/);
    expect(before).toContain('...recapKind');
  });
});
