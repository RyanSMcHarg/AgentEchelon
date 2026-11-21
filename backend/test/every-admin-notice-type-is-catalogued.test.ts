/**
 * EVERY ADMIN NOTICE IS ROUTED (DESIGN-EVENT-TARGETS section 12): AdminServices posts a notice only through the rule its
 * `messageType` has in the catalog, so a raiser naming a type the catalog does not list would post nowhere. This scans every
 * raiser in the Lambda source and refuses an uncatalogued type, and refuses a catalogued template the platform does not ship,
 * since a notice whose template is not shipped posts the raiser's own text.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ADMIN_NOTICE_TYPES, BOUNDARY_REFUSAL_ALARM_SUFFIX, switchableNotice } from '../lambda/src/lib/admin-notice-types';
import { shippedAdminNotices } from '../lambda/src/lib/admin-notice-templates';

const SRC = path.join(__dirname, '..', 'lambda', 'src');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

/** The arguments of each call to `fn` in `src`, split at depth one. */
function callArgs(src: string, fn: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${fn}\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const args: string[] = [];
    let start = i;
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i];
      if (c === '(' || c === '{' || c === '[') depth += 1;
      else if (c === ')' || c === '}' || c === ']') depth -= 1;
      if ((c === ',' && depth === 1) || depth === 0) { args.push(src.slice(start, i).trim()); start = i + 1; }
    }
    out.push(args);
  }
  return out;
}

const RAISERS = sources(SRC)
  .filter((f) => !/[\\/]lib[\\/]admin-notice(-types)?\.ts$/.test(f))
  .map((f) => ({ file: path.relative(SRC, f), src: fs.readFileSync(f, 'utf8') }));

/** Every messageType a raiser names: the second argument of `adminNotice(`, and a literal `messageType:` it posts directly. */
const raised = RAISERS.flatMap(({ file, src }) => [
  ...callArgs(src, 'adminNotice').map((a) => ({ file, type: /^'([^']+)'$/.exec(a[1] ?? '')?.[1] ?? `<not a literal: ${a[1]}>` })),
  ...(src.includes('postAdminNotice(') ? [...src.matchAll(/messageType: '([^']+)'/g)].map((m) => ({ file, type: m[1] })) : []),
]);

describe('every admin notice type is catalogued', () => {
  it('finds the raisers it is meant to guard', () => {
    expect(new Set(raised.map((r) => r.file)).size).toBeGreaterThanOrEqual(7);
    // And every catalogued type is one a raiser names, so the catalog holds no rule for a notice nothing raises.
    const types = new Set(raised.map((r) => r.type));
    expect(ADMIN_NOTICE_TYPES.filter((t) => !types.has(t.messageType)).map((t) => t.key)).toEqual([]);
  });

  it('DENY: a raiser naming a messageType the catalog does not list', () => {
    const known = new Set(ADMIN_NOTICE_TYPES.map((t) => t.messageType));
    expect(raised.filter((r) => !known.has(r.type)).map((r) => `${r.file}: ${r.type}`)).toEqual([]);
  });

  it('DENY: a catalogued template the platform does not ship', () => {
    const shipped = shippedAdminNotices();
    expect(ADMIN_NOTICE_TYPES.flatMap((t) => t.templates.filter((n) => !shipped.has(n)).map((n) => `${t.key}: ${n}`))).toEqual([]);
  });

  it('holds the security notices always on, and splits the boundary refusal alarm from every other alarm', () => {
    expect(ADMIN_NOTICE_TYPES.filter((t) => t.security).map((t) => t.key).sort())
      .toEqual(['activated-past-golden-gate', 'boundary-refusal-alarm', 'membership-audit']);
    expect(switchableNotice('membership-audit')).toBeUndefined();
    expect(switchableNotice('alarm')?.key).toBe('alarm');
    expect(new Set(ADMIN_NOTICE_TYPES.map((t) => t.key)).size).toBe(ADMIN_NOTICE_TYPES.length);
    // The suffix is the boundary refusal alarm's own (`archive-stack-aurora.ts`).
    const archive = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stacks', 'archive-stack-aurora.ts'), 'utf8');
    expect(archive).toContain(`alarmName: \`\${this.stackName}${BOUNDARY_REFUSAL_ALARM_SUFFIX}\``);
  });
});
