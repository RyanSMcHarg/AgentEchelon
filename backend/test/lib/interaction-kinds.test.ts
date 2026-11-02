/**
 * THE INTERACTION VOCABULARY, and the two rules that keep it from rotting.
 *
 * RULE 1 - EVERY KIND HAS A PRODUCER. A value nothing emits is the inert-mechanism shape this repo
 * keeps finding: a vocabulary that looks complete, a console offering filters that return nothing,
 * and no error anywhere to say so. This is why the list is four entries and not the seven a
 * brainstorm produces - a welcome, a drift offer and a scheduled briefing are real messages, but none
 * is a model turn with compute to attribute, so none of them gets a name here until one is.
 *
 * RULE 2 - "IS SOMEBODY WAITING?" IS THE AXIS THAT MATTERS. It decides whether the published
 * response-time limits apply, so a kind on the wrong side of it silently moves a UX number using
 * turns no user was sitting in front of - or hides a real wait from the metric that watches it.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  INTERACTION_KINDS,
  isHumanWaiting,
  isInteractionKind,
  normaliseLegacyTrigger,
} from '../../lambda/src/lib/interaction-kinds';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');

/** Every `trigger: '<kind>'` a producer declares, read from the source rather than remembered. */
function declaredKinds(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\btrigger:\s*'([a-z_]+)'/g)) found.add(m[1]);
    }
  };
  walk(SRC);
  return found;
}

describe('every kind is actually produced', () => {
  it('each declared kind is one the vocabulary knows', () => {
    // Catches the opposite drift: a producer inventing a value the ledger and console cannot read.
    // The offending NAMES go in the assertion VALUE, not in a message argument: jest's expect takes
    // no message, and a bare "expected true, received false" would not say which producer drifted.
    const unknown = [...declaredKinds()].filter((k) => !isInteractionKind(k));
    expect({ producersDeclaringUnknownKinds: unknown }).toEqual({ producersDeclaringUnknownKinds: [] });
  });

  it('every kind in the vocabulary has at least one producer', () => {
    const declared = declaredKinds();
    // `user` is declared by the channel flow; the rest by their dispatchers. A kind with no producer
    // would render as an always-empty row on the interaction breakdown.
    const orphans = INTERACTION_KINDS.filter((k) => !declared.has(k));
    expect({ kindsWithNoProducer: orphans }).toEqual({ kindsWithNoProducer: [] });
  });
});

describe('who is waiting decides which SLO applies', () => {
  it('a rebuttal is NOT a person waiting', () => {
    // It answers the rival. Counting it as a human wait would drag the perceived-latency metric with
    // turns nobody was watching for.
    expect(isHumanWaiting('rebuttal')).toBe(false);
  });

  it('a join recap is NOT a person waiting', () => {
    // The person was added; they asked for nothing, so no response-time limit is theirs to feel.
    expect(isHumanWaiting('join_recap')).toBe(false);
  });

  it('a handover and a repair ARE a person waiting', () => {
    // Both start from a real message somebody sent and is still waiting on - they were routed badly,
    // which makes the wait longer, not less real. Excluding them would hide the worst waits from the
    // metric that exists to catch them.
    expect(isHumanWaiting('handover')).toBe(true);
    expect(isHumanWaiting('repair')).toBe(true);
  });

  it('an undeclared trigger reads as a user turn', () => {
    // The historical default. Changing it would silently reclassify every row written before kinds
    // were forwarded at all.
    expect(isHumanWaiting(null)).toBe(true);
    expect(isHumanWaiting(undefined)).toBe(true);
    expect(isHumanWaiting('')).toBe(true);
  });
});

describe('legacy rows stay readable', () => {
  it('maps the old dispatcher name onto the interaction it was used for', () => {
    // 'orchestrator' named the dispatcher, so it covered BOTH a rebuttal and a repair and cannot be
    // separated after the fact. It maps to the one it was overwhelmingly used for.
    expect(normaliseLegacyTrigger('orchestrator')).toBe('rebuttal');
  });

  it('passes a current kind through unchanged', () => {
    expect(normaliseLegacyTrigger('repair')).toBe('repair');
  });

  it('turns an unrecognised value into an absent one, never a guess', () => {
    expect(normaliseLegacyTrigger('something-new')).toBeNull();
    expect(normaliseLegacyTrigger(null)).toBeNull();
    expect(normaliseLegacyTrigger('')).toBeNull();
  });
});
