/**
 * A DRAFT, READ AS ITS AREAS.
 *
 * What it proves: every version field the console edits belongs to exactly one area, and a field no area owns is
 * still in the diff under `other`; the diff names each changed field as added, removed or changed, compares by
 * content (key order and an absent value do not count), splits the welcome (assistant-joined) from the other event
 * workflows, and with nothing active reads every set field as added; a step's unsaved patch applies over the draft
 * with `null` removing a field; each area's sentence says what the draft holds, in the locale's words.
 */
import { describe, it, expect } from 'vitest';
import i18n from '@ae/shared/i18n';
import { DRAFT_AREAS, areaFields, areaSummary, draftDiff, stable, withPatch } from './draftAreas';
import type { ProfileDefinitionBody } from '../../services/profileService';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

const welcome = (text: string, types?: string[]) => ({
  on: 'assistant-joined' as const, ...(types ? { types } : {}), initial: 'opening',
  states: { opening: { opening: { text }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' as const } },
});
const chase = { on: 'invitation-unredeemed' as const, deadline: { afterMinutes: 60 }, initial: 'd', states: { d: { disposition: 'success' as const } } };

const ACTIVE: ProfileDefinitionBody = {
  modelKey: 'sonnet',
  models: { default: 'sonnet', classifier: 'default', byIntent: { report: { primary: 'sonnet' } } },
  displayName: 'Advisor',
  persona: 'You advise.',
  tools: ['search'],
  eventWorkflows: { welcome: welcome('Hello.') },
  intentPack: { intents: [{ key: 'report' }] },
};

describe('the areas', () => {
  it('give every field the console edits one owner', () => {
    const body: ProfileDefinitionBody = {
      ...ACTIVE, guardrailId: 'g', contextSources: ['crm'], messages: { m: '@shipped' }, variables: { v: { source: 'person:displayName' } },
      models: { ...ACTIVE.models, routing: [{ when: {} as never, model: 'haiku' }] }, eventWorkflows: { welcome: welcome('Hi.'), chase },
    };
    const owners = new Map<string, string[]>();
    for (const area of DRAFT_AREAS) {
      for (const [path, v] of Object.entries(areaFields(area, body))) {
        if (v === undefined) continue;
        owners.set(path, [...(owners.get(path) ?? []), area]);
      }
    }
    for (const [path, areas] of owners) expect(areas, path).toHaveLength(1);
    expect(owners.get('eventWorkflows.welcome')).toEqual(['welcome']);
    expect(owners.get('eventWorkflows.chase')).toEqual(['events']);
    expect(owners.get('models.routing')).toEqual(['routing']);
  });
});

describe('the diff against the active version', () => {
  it('names each changed field, area by area, and leaves unchanged areas out', () => {
    const draft = { ...ACTIVE, persona: 'You advise briefly.', tools: undefined, guardrailId: 'gr', eventWorkflows: { welcome: welcome('Hello.'), chase } };
    const diff = draftDiff(ACTIVE, draft);
    expect(diff.map((d) => d.area)).toEqual(['identity', 'abilities', 'events']);
    expect(diff[0].changes).toEqual([{ path: 'persona', change: 'changed' }]);
    expect(diff[1].changes).toEqual([{ path: 'guardrailId', change: 'added' }, { path: 'tools', change: 'removed' }]);
    expect(diff[2].changes).toEqual([{ path: 'eventWorkflows.chase', change: 'added' }]);
  });

  it('compares by content: key order and an absent value are no change', () => {
    const reordered = { ...ACTIVE, models: { byIntent: { report: { primary: 'sonnet' } }, classifier: 'default', default: 'sonnet' }, boundary: undefined };
    expect(draftDiff(ACTIVE, reordered)).toEqual([]);
    expect(stable({ a: 1, b: undefined })).toBe(stable({ a: 1 }));
  });

  it('reports a field no area owns under other, so an imported change is never hidden', () => {
    const draft = { ...ACTIVE, intentPack: { intents: [{ key: 'report' }, { key: 'pricing' }] }, boundary: 'No payroll.' };
    const other = draftDiff(ACTIVE, draft).find((d) => d.area === 'other');
    expect(other?.changes).toEqual([{ path: 'boundary', change: 'added' }, { path: 'intentPack', change: 'changed' }]);
  });

  it('reads every set field as added while nothing is active', () => {
    const diff = draftDiff(null, ACTIVE);
    expect(diff.find((d) => d.area === 'identity')?.changes).toEqual([
      { path: 'displayName', change: 'added' }, { path: 'persona', change: 'added' },
    ]);
    expect(diff.find((d) => d.area === 'welcome')?.changes).toEqual([{ path: 'eventWorkflows.welcome', change: 'added' }]);
  });
});

describe('a step\'s unsaved patch', () => {
  it('applies over the draft, and null removes a field', () => {
    expect(withPatch(ACTIVE, { persona: null, displayName: 'Tax' })).toMatchObject({ displayName: 'Tax' });
    expect(withPatch(ACTIVE, { persona: null })).not.toHaveProperty('persona');
  });
});

describe('one sentence per area', () => {
  it('says what the draft holds', () => {
    expect(areaSummary('identity', ACTIVE, t)).toBe('Advisor, with a persona of 11 characters.');
    expect(areaSummary('identity', { modelKey: 'x' }, t, 'tax-advisor')).toBe("tax-advisor, answering with the classification's persona.");
    expect(areaSummary('abilities', ACTIVE, t)).toBe("Tools offered: 1; context sources read: 0; guardrail: the classification's.");
    expect(areaSummary('models', ACTIVE, t)).toBe('Answers on sonnet and classifies on the platform classifier, with 1 intent route.');
    expect(areaSummary('routing', ACTIVE, t)).toBe('No routing rules; each turn takes the model its intent routes to.');
    expect(areaSummary('welcome', ACTIVE, t)).toBe('Its own welcome greets every other room.');
    expect(areaSummary('welcome', { modelKey: 'x', eventWorkflows: { w: welcome('Ops.', ['ops']) } }, t)).toBe('Its own welcome greets ops.');
    expect(areaSummary('welcome', { modelKey: 'x' }, t)).toBe("The platform's welcome greets every room.");
    expect(areaSummary('messages', { modelKey: 'x', messages: { a: '@shipped', b: '@classification' } }, t))
      .toBe('2 messages say a template chosen for this version; the rest say their usual one.');
    expect(areaSummary('events', { modelKey: 'x', eventWorkflows: { chase } }, t)).toBe('1 event workflow, on invitation-unredeemed.');
    expect(areaSummary('events', ACTIVE, t)).toBe('No event workflows besides the welcome.');
    expect(areaSummary('variables', { modelKey: 'x', variables: { team: { source: 'fact:team' } } }, t)).toBe('1 variable: team.');
  });
});
