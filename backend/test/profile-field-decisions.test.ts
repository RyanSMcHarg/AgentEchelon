/**
 * EVERY FIELD OF A PROFILE VERSION HAS A DECISION ON THE ASSISTANT PAGE (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * The owner's rule: an element of an assistant's page is a control with help, JSON with its edit path, or
 * read-only with what drives it. A body field nobody decided about rides every version, changes behavior,
 * and the page says nothing about it. `PROFILE_FIELD_DECISIONS` is the one declared table the console reads
 * (served with the listing), and this reads `ProfileDefinitionBody` from its SOURCE, so adding a body field
 * without an entry fails here even if the type-level check were loosened.
 *
 * `copy` is retired (ADR-062): every key `AssistantCopy` declares has a template `npm run migrate-legacy-copy` writes
 * its line to, and the draft refuses a line under it.
 *
 * Pattern: versioned-profile-omits-deploy-time-fields.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PROFILE_FIELD_DECISIONS } from '../lambda/src/lib/profile-field-decisions';
import { patchShapeErrors, retiredCopyErrors, retiredWelcomeErrors } from '../lambda/src/lib/profile-copy-fields';
import { openingStepErrors } from '../lambda/src/lib/welcome-orientation';
import { legacyCopyPlan } from '../lambda/src/lib/legacy-copy-migration';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'lambda', 'src', 'lib', 'active-profile.ts'), 'utf8');

/** The top-level keys of an interface in the source, by its two-space member indentation. */
function interfaceKeys(name: string): string[] {
  const start = SOURCE.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found in active-profile.ts`);
  const end = SOURCE.indexOf('\n}\n', start);
  const body = SOURCE.slice(start, end);
  return [...body.matchAll(/^ {2}([A-Za-z]+)\??:/gm)].map((m) => m[1]);
}

describe('the assistant page decides every version field', () => {
  const bodyKeys = interfaceKeys('ProfileDefinitionBody');

  it('reads a plausible body from the source, so the checks below are not vacuous', () => {
    expect(bodyKeys).toEqual(expect.arrayContaining(['models', 'persona', 'welcome', 'copy', 'onboarding', 'intentPack']));
    expect(bodyKeys.length).toBeGreaterThan(10);
  });

  it('has a decision for every ProfileDefinitionBody key, and none for a key the body lacks', () => {
    const decided = Object.keys(PROFILE_FIELD_DECISIONS).sort();
    const missing = bodyKeys.filter((k) => !decided.includes(k));
    const stale = decided.filter((k) => !bodyKeys.includes(k));
    if (missing.length) {
      throw new Error(
        `ProfileDefinitionBody gained ${missing.join(', ')} with no decision. Add each to PROFILE_FIELD_DECISIONS `
        + '(lib/profile-field-decisions.ts): a console control, JSON with its edit path, or read-only with what drives it.',
      );
    }
    expect(stale).toEqual([]);
  });

  it('gives the welcome workflows a control, keeps the agreed JSON fields JSON, and explains the retired copy and welcome', () => {
    expect(PROFILE_FIELD_DECISIONS.eventWorkflows.kind).toBe('control');
    expect(PROFILE_FIELD_DECISIONS.welcome).toEqual({ kind: 'readonly', drivenBy: 'migration', guide: 'welcome' });
    expect(PROFILE_FIELD_DECISIONS.copy.kind).toBe('readonly');
    for (const k of ['onboarding', 'intentPack', 'machines', 'workflows'] as const) {
      expect(PROFILE_FIELD_DECISIONS[k].kind).toBe('json');
    }
  });

  it('names a command and a guide for every JSON field, and what drives every read-only one', () => {
    for (const [k, d] of Object.entries(PROFILE_FIELD_DECISIONS)) {
      if (d.kind === 'json') {
        expect(`${k}: ${d.command}`).toMatch(/: npm run /);
        expect(`${k}: ${d.guide}`).toMatch(/: [a-zA-Z]+$/);
      }
      if (d.kind === 'readonly') expect(`${k}: ${d.drivenBy}`).toMatch(/: [a-z-]+$/);
    }
  });
});

describe('every retired `copy` key has a template the migration writes it to', () => {
  const copyKeys = interfaceKeys('AssistantCopy');

  it('each single line maps to one shipped template, and each group key to a section', () => {
    const unmapped = copyKeys.filter((k) => !['queueStatus', 'email'].includes(k) && legacyCopyPlan({ [k]: 'A line.' }).templates.length !== 1);
    expect(unmapped).toEqual([]);
    expect(legacyCopyPlan({ queueStatus: { waiting: 'Held' } }).templates).toEqual([expect.objectContaining({ name: 'queue-status', keys: ['queueStatus.waiting'] })]);
    expect(legacyCopyPlan({ email: { greeting: 'Hello {name},' } }).templates).toEqual([expect.objectContaining({ name: 'notification-email', keys: ['email.greeting'] })]);
  });
});

describe('the draft refuses a `copy` line and a retired welcome, and an opening step is checked as sent', () => {
  it('refuses any copy line, naming the migration; null and an empty object clear it', () => {
    const [refusal] = patchShapeErrors({ copy: { rateLimited: 'Slow down', email: { greeting: 'Hello {name},' } } } as never);
    expect(refusal).toMatch(/copy is retired \(it holds rateLimited, email\)/);
    expect(refusal).toContain('npm run migrate-legacy-copy');
    expect(retiredCopyErrors('hello')[0]).toContain('npm run migrate-legacy-copy');
    expect(patchShapeErrors({ copy: null } as never)).toEqual([]);
    expect(patchShapeErrors({ copy: {} } as never)).toEqual([]);
    expect(retiredCopyErrors(undefined)).toEqual([]);
  });

  it('refuses a welcome, naming the migration; null clears it', () => {
    expect(patchShapeErrors({ welcome: { template: 'Hi, I am Ops.' } } as never)[0]).toContain('npm run migrate-legacy-welcome');
    expect(retiredWelcomeErrors({})[0]).toContain('npm run migrate-legacy-welcome');
    expect(patchShapeErrors({ welcome: null } as never)).toEqual([]);
  });

  it('accepts the opening step the console sends', () => {
    expect(openingStepErrors({ text: 'Hi, I am Ops.', examples: ['What broke?'] }, 'o')).toEqual([]);
    expect(openingStepErrors({}, 'o')).toEqual([]);
  });

  it('copy is not a control: the console explains it is retired and how its lines move', () => {
    expect(PROFILE_FIELD_DECISIONS.copy).toEqual({ kind: 'readonly', drivenBy: 'migration', guide: 'messages' });
  });

  it('refuses a per-conversation field, too many prompts, and a field it does not know', () => {
    expect(openingStepErrors({ topic: 'x' }, 'o')[0]).toMatch(/carried per conversation/);
    expect(openingStepErrors({ examples: ['a', 'b', 'c', 'd', 'e'] }, 'o')[0]).toMatch(/at most 4/);
    expect(openingStepErrors({ examples: 'a' }, 'o')[0]).toMatch(/list of non-blank prompts/);
    expect(openingStepErrors({ template: 'x' }, 'o')[0]).toMatch(/not a field of an opening/);
    expect(openingStepErrors([], 'o')[0]).toMatch(/is an object of orientation fields/);
  });
});
