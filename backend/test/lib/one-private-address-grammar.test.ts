/**
 * ONE PRIVATE-ADDRESS GRAMMAR, WRITTEN TWICE.
 *
 * `mentionParser.ts` in the chat client and `lib/private-prefix.ts` in the backend each define the
 * same two patterns and each parse the same token. They have to, because the client lexes what is
 * being TYPED and the flow lexes what was SENT, and neither can import the other across the
 * frontend/backend boundary.
 *
 * NOTHING HELD THEM TOGETHER UNTIL NOW, and the copies were already identical by hand. That is a
 * standing hazard rather than a resolved one: the two sides disagreeing about where a name ends is
 * the client showing a "Private to Sam" chip for a message the flow delivers to the room, which is the
 * one failure direction this feature exists to prevent (a message meant for one person cannot be
 * taken back).
 *
 * Adding the id form doubled the surface - a split, a fallback order and a raw-token retry, all of
 * which must agree - so the guard is written now rather than after the first disagreement.
 *
 * SOURCE-LEVEL ON PURPOSE. Jest cannot import the client module (its own toolchain, its own
 * `@ae/shared` aliases), so the patterns are compared as text. That is weaker than executing both,
 * and it catches the thing that actually drifts: someone widening one regex and not the other.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const backend = fs.readFileSync(
  path.join(ROOT, 'backend/lambda/src/lib/private-prefix.ts'), 'utf8',
);
const client = fs.readFileSync(
  path.join(ROOT, 'frontend/packages/chat/src/utils/mentionParser.ts'), 'utf8',
);

/** The literal a file defines for `name`, so the two can be compared without running either. */
function pattern(src: string, name: string): string {
  const m = new RegExp(`const ${name} = (/.*/[a-z]*);`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[1];
}

describe('the two sides lex a private address identically', () => {
  it('uses the same bare pattern', () => {
    expect(pattern(client, 'PRIVATE_PREFIX')).toBe(pattern(backend, 'PRIVATE_PREFIX'));
  });

  it('uses the same delimited pattern', () => {
    expect(pattern(client, 'PRIVATE_PREFIX_DELIMITED'))
      .toBe(pattern(backend, 'PRIVATE_PREFIX_DELIMITED'));
  });

  it('is not comparing nothing, which is how a text guard passes vacuously', () => {
    // NON-VACUITY. `pattern` throws when a name is absent, but a rename on BOTH sides would leave two
    // empty strings comparing equal if it ever returned one. It cannot, and this says so.
    expect(pattern(backend, 'PRIVATE_PREFIX')).toMatch(/^\/\^/);
    expect(pattern(backend, 'PRIVATE_PREFIX_DELIMITED')).toContain('<');
  });
});

describe('and they split the id out of it identically', () => {
  it('both split on the LAST separator', () => {
    // The rule that lets a display name hold a separator: only the final segment is read as an id.
    expect(backend).toContain("token.lastIndexOf('|')");
    expect(client).toContain("token.lastIndexOf('|')");
  });

  it('both keep the raw token, because the split is a guess about a name', () => {
    // A member genuinely called `A|B` addressed by hand parses as name `A` with id `B`. Both sides
    // keep the unsplit token so that member still resolves, rather than banning the character.
    expect(backend).toContain('raw: token');
    expect(client).toContain('raw: token');
  });

  it('both resolve the id against the roster before falling back to the name', () => {
    // ORDER IS THE WHOLE POINT. Name-first would keep the ambiguity the id exists to remove, and
    // roster-scoping is what stops a crafted id naming somebody outside the conversation.
    const idBeforeName = (src: string, idNeedle: string, nameNeedle: string) => {
      const i = src.indexOf(idNeedle);
      const n = src.indexOf(nameNeedle, i);
      expect(i).toBeGreaterThan(-1);
      expect(n).toBeGreaterThan(i);
    };
    idBeforeName(backend, "m.arn.split('/').pop() === id", 'const wanted = address.name.toLowerCase()');
    idBeforeName(client, "m.userArn?.split(\"/\").pop() === privateAddress.id", 'm.name.toLowerCase() === privateAddress.name.toLowerCase()');
  });
});

/**
 * THE `@mention` GRAMMAR IS ALSO TWO COPIES, AND THEY MUST STAY ONE GRAMMAR.
 *
 * `@<Name|id>` is what the picker writes so the channel flow can resolve a member
 * by id rather than by matching a display name two people can share. The flow callback carries no
 * `MessageAttributes`, so the ARNs in `CHIME.mentions` never reach it, and the one beside-channel that
 * does reach it - `Metadata` - is member-writable, which would let a different member redirect somebody
 * else's mention. So the id rides in the text, and the text is parsed on both sides.
 *
 * Same failure mode as the private prefix: if the two copies drift, a message resolves to one member in
 * the browser and another in the flow, or to nobody at all, and nothing fails loudly.
 */
describe('one @mention grammar, two copies', () => {
  const backend = fs.readFileSync(
    path.join(__dirname, '../../lambda/src/lib/flow-bypass.ts'), 'utf8',
  );
  const frontend = fs.readFileSync(
    path.join(__dirname, '../../../frontend/packages/chat/src/utils/mentionParser.ts'), 'utf8',
  );

  it('uses the same delimited pattern on both sides', () => {
    // Built rather than written as a literal, so this file's own escaping cannot make the assertion
    // disagree with the source it is checking.
    const pattern = ['/@<([^<>', String.raw`\n`, ']{1,128})>/g'].join('');
    expect(backend).toContain(pattern);
    expect(frontend).toContain(pattern);
  });

  it('splits on the LAST separator on both sides, so a name may contain one', () => {
    // `A|B|sub-1` is the name `A|B`, not `A`. A member genuinely called `A|B` would otherwise resolve
    // as `A` and the mention would reach the wrong person.
    for (const src of [backend, frontend]) {
      expect(src).toContain("raw.lastIndexOf('|')");
      expect(src).toMatch(/cut > 0 && cut < raw\.length - 1/);
    }
  });

  it('keeps the raw token on both sides, so the split stays a guess it can back out of', () => {
    for (const src of [backend, frontend]) expect(src).toMatch(/raw,\s*at/);
  });

  it('BLANKS the delimited tokens rather than removing them, on both sides', () => {
    // Equal-length spaces keep every index aligned with the original. The frontend sorts mentions by
    // index to decide order; the backend prefers the EARLIEST token. A length-changing rewrite would
    // reorder one and change which member the other resolves to.
    for (const src of [backend, frontend]) {
      expect(src).toContain("' '.repeat(match[0].length)");
    }
  });

  it('tries the id before the name, on both sides', () => {
    for (const src of [backend, frontend]) {
      expect(src).toMatch(/split\('\/'\)\.pop\(\) === token\.id/);
    }
  });
});
