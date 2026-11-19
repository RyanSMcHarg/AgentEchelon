/**
 * THE COMPOSER'S DRAFT (`composerMentions.ts`): the field reads `@Name`, the send carries `@<Name|id>`, an edit beside a
 * mention moves it, and an edit inside one leaves plain text.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_DRAFT, addressPrivatelyInDraft, draftFromEncoded, editDraft, encodeDraft, leadingPrivateAddress, mentionInDraft, messageStart,
  pickIntoDraft, withoutShadowedMentions,
} from './composerMentions';

const OPS = '@<Ops|00000000-0000-4000-8000-0000000000a1>';

describe("the composer's draft", () => {
  it('shows a picked member by name and sends the token', () => {
    const d = pickIntoDraft({ text: '@Op', mentions: [] }, 0, 3, '@Ops', OPS);
    expect(d.text).toBe('@Ops ');
    expect(encodeDraft(d)).toBe(`${OPS} `);
    const typed = editDraft(d, '@Ops where is the dashboard?');
    expect(encodeDraft(typed)).toBe(`${OPS} where is the dashboard?`);
  });

  it('moves a mention with text typed before it', () => {
    const d = pickIntoDraft({ text: 'hi @Op', mentions: [] }, 3, 6, '@Ops', OPS);
    expect(encodeDraft(editDraft(d, 'oh hi @Ops '))).toBe(`oh hi ${OPS} `);
    // An `@` typed right before the mention is placed by the caret, not inside the mention.
    expect(encodeDraft(editDraft(d, 'hi @@Ops ', 4))).toBe(`hi @${OPS} `);
  });

  it('leaves plain text when part of a mention is deleted or typed into', () => {
    const d = pickIntoDraft(EMPTY_DRAFT, 0, 0, '@Ops', OPS);
    expect(encodeDraft(editDraft(d, '@Op '))).toBe('@Op ');
    expect(encodeDraft(editDraft(d, '@Opxs ', 4))).toBe('@Opxs ');
    expect(encodeDraft(editDraft(d, ''))).toBe('');
  });

  it('keeps a text the same when the member has no id to carry', () => {
    const d = pickIntoDraft({ text: '@al', mentions: [] }, 0, 3, '@all', '@all');
    expect(d.mentions).toEqual([]);
    expect(encodeDraft(d)).toBe('@all ');
  });

  it('reads a private address and mentions back from their sent form', () => {
    const d = draftFromEncoded(`.<Ryan McHarg|ryan> ask ${OPS} now`);
    expect(d.text).toBe('.Ryan McHarg ask @Ops now');
    expect(encodeDraft(d)).toBe(`.<Ryan McHarg|ryan> ask ${OPS} now`);
  });

  it('DENY: text typed straight onto a picked name carries no id, so the field never names one member and sends another', () => {
    const picked = pickIntoDraft(EMPTY_DRAFT, 0, 0, '@Sam', '@<Sam|sam-id>');
    // The trailing space is deleted and the name is typed on: the field reads @Samantha.
    const joined = editDraft(editDraft(picked, '@Sam'), '@Samantha hi');
    expect(joined.mentions).toEqual([]);
    expect(encodeDraft(joined)).toBe('@Samantha hi');
  });

  it('DENY: a pick that a longer member name stands over lets its id go', () => {
    const picked = editDraft(pickIntoDraft(EMPTY_DRAFT, 0, 0, '@Advisor', '@<Advisor|adv-id>'), '@Advisor (alt) what is our NRR?');
    expect(encodeDraft(picked)).toBe('@<Advisor|adv-id> (alt) what is our NRR?');
    const sent = withoutShadowedMentions(picked, ['Advisor', 'Advisor (alt)', 'Sam']);
    expect(encodeDraft(sent)).toBe('@Advisor (alt) what is our NRR?');
    // A pick followed by ordinary words keeps its id.
    const plain = editDraft(pickIntoDraft(EMPTY_DRAFT, 0, 0, '@Advisor', '@<Advisor|adv-id>'), '@Advisor what is our NRR?');
    expect(encodeDraft(withoutShadowedMentions(plain, ['Advisor', 'Advisor (alt)']))).toBe('@<Advisor|adv-id> what is our NRR?');
  });
});

describe('a member addressed from outside the composer keeps the front of the message meaning what it means', () => {
  const NAMES = ['Alice', 'Ryan McHarg', 'Advisor'];
  const ALICE = '.<Alice|alice-id>';
  const RYAN = '.<Ryan McHarg|ryan-id>';

  it('a private address goes after a leading /md command', () => {
    const { draft, caret } = addressPrivatelyInDraft(draftFromEncoded('/md **numbers**'), '.Alice', ALICE, NAMES);
    expect(draft.text).toBe('/md .Alice **numbers**');
    expect(encodeDraft(draft)).toBe(`/md ${ALICE} **numbers**`);
    expect(caret).toBe('/md .Alice '.length);
  });

  it('a leading dot-word that names no member is the person\'s words, and stays', () => {
    const { draft } = addressPrivatelyInDraft(draftFromEncoded('.env is missing'), '.Alice', ALICE, NAMES);
    expect(encodeDraft(draft)).toBe(`${ALICE} .env is missing`);
  });

  it('replaces a private address already there, picked or typed, and nothing else', () => {
    const picked = addressPrivatelyInDraft(draftFromEncoded(`${RYAN} the numbers`), '.Alice', ALICE, NAMES);
    expect(encodeDraft(picked.draft)).toBe(`${ALICE} the numbers`);
    const typed = addressPrivatelyInDraft(draftFromEncoded('.ryan mcharg the numbers'), '.Alice', ALICE, NAMES);
    expect(encodeDraft(typed.draft)).toBe(`${ALICE} the numbers`);
    const withMd = addressPrivatelyInDraft(draftFromEncoded(`/md ${RYAN} hi`), '.Alice', ALICE, NAMES);
    expect(encodeDraft(withMd.draft)).toBe(`/md ${ALICE} hi`);
  });

  it('a mention at the front of a private draft goes after the address, never in front of it', () => {
    const d = draftFromEncoded(`${ALICE} see this`);
    const { draft, caret } = mentionInDraft(d, 0, '@Advisor', '@<Advisor|advisor>', NAMES);
    expect(encodeDraft(draft)).toBe(`${ALICE} @<Advisor|advisor> see this`);
    expect(draft.text.slice(0, caret)).toBe('.Alice @Advisor ');
  });

  it('a mention never goes in front of /md, and elsewhere goes in at the caret with a space before it', () => {
    expect(encodeDraft(mentionInDraft(draftFromEncoded('/md hi'), 0, '@Advisor', '@<Advisor|advisor>', NAMES).draft))
      .toBe('/md @<Advisor|advisor> hi');
    expect(encodeDraft(mentionInDraft(draftFromEncoded('ping'), 4, '@Advisor', '@<Advisor|advisor>', NAMES).draft))
      .toBe('ping @<Advisor|advisor> ');
  });

  it('leadingPrivateAddress reads only an address, the longest member name winning', () => {
    expect(leadingPrivateAddress(draftFromEncoded('.env x'), NAMES)).toBeNull();
    expect(leadingPrivateAddress(draftFromEncoded('.Alice x'), NAMES)).toEqual({ start: 0, end: 6 });
    expect(leadingPrivateAddress(draftFromEncoded('.Alicex'), NAMES)).toBeNull();
    expect(leadingPrivateAddress({ text: '.<Somebody> x', mentions: [] }, NAMES)).toEqual({ start: 0, end: 11 });
    expect(leadingPrivateAddress(draftFromEncoded('.<Somebody> x'), NAMES)).toEqual({ start: 0, end: 9 });
    expect(messageStart('  /MD  x')).toBe(7);
  });
});

describe('one token grammar', () => {
  it('the composer and the target check carry no pattern of their own: they read the shared one', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const token = String.raw`[^<>\n]{1,128}`;
    for (const file of ['./composerMentions.ts', './targetIntegrity.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source.includes(token), file).toBe(false);
    }
  });

  it('reads a leading private address the way the shared reader does', async () => {
    const { encodedPrivateAddress } = await import('./composerMentions');
    const { encodeAddressTokens } = await import('@ae/shared/utils/addressTokens.ts');
    for (const text of ['.<Sam|sam-2> hi', '/md .<A|B|id-1> **x**', '.<Sam> hi', '.Sam hi', 'hi .<Sam|s>']) {
      const shared = encodeAddressTokens(text).tokens.find((t) => t.kind === 'address');
      const mine = encodedPrivateAddress(text);
      expect(mine ? { name: mine.name, id: mine.id } : undefined, text).toEqual(shared ? { name: shared.name, id: shared.id } : undefined);
    }
  });
});
