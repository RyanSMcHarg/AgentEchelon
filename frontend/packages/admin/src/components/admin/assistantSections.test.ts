/**
 * AN ASSISTANT'S PAGE, READ AS ITS SECTIONS: the menu's changed marks are the draft's own diff, a platform workflow is
 * copied in under a free name, and an intent's card joins the version's pack, the classification's and the version's
 * routes, so every model a version chooses is on a card.
 */
import { describe, it, expect } from 'vitest';
import { PLATFORM_EVENT_WORKFLOWS } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { DRAFT_AREAS } from './draftAreas';
import { CREATION_STEPS, SECTIONS, SECTION_AREAS, WIZARD_SECTIONS, changedSections, creationSteps, copyName, intentCards, intentsRunning, ownWorkflows, packIntentKeys, platformWorkflows, withPlatformCopy } from './assistantSections';
import type { ClassificationCatalog, ProfileDefinitionBody } from '../../services/profileService';

const body = (over: Partial<ProfileDefinitionBody>): ProfileDefinitionBody => ({ modelKey: 'sonnet', ...over });

describe('the sections and the draft areas they edit', () => {
  it('places every draft area in exactly one section', () => {
    const placed = SECTIONS.flatMap((s) => SECTION_AREAS[s]);
    expect([...placed].sort()).toEqual([...DRAFT_AREAS].sort());
  });

  it('marks the sections whose areas the draft changes, and only those', () => {
    const active = body({ persona: 'a', tools: ['x'] });
    expect([...changedSections(active, body({ persona: 'b', tools: ['x'] }))]).toEqual(['behavioral']);
    expect([...changedSections(active, body({ persona: 'a', tools: ['x'], models: { default: 'haiku' } }))]).toEqual(['scope']);
    expect(changedSections(active, body({ persona: 'a', tools: ['x'] })).size).toBe(0);
    // Nothing active: every section the draft sets reads as changed.
    expect(changedSections(null, body({ persona: 'b' })).has('behavioral')).toBe(true);
  });
});

describe('the creation wizard steps', () => {
  it('are the two that make the assistant, then the editable sections in the page order, then the review', () => {
    expect(CREATION_STEPS).toEqual(['assistant', 'start', 'behavioral', 'workflows', 'scope', 'tools', 'review']);
    expect(SECTIONS.filter((s) => (WIZARD_SECTIONS as readonly string[]).includes(s))).toEqual([...WIZARD_SECTIONS]);
    // A section step takes the page's own title; the others the create's.
    expect(creationSteps((k) => k).map((s) => s.label)).toEqual([
      'admin.create.step.assistant', 'admin.create.step.start',
      'admin.assistantPage.sections.behavioral.title', 'admin.assistantPage.sections.workflows.title',
      'admin.assistantPage.sections.scope.title', 'admin.assistantPage.sections.tools.title', 'admin.create.step.review',
    ]);
  });
});

describe('workflows by ownership', () => {
  it('splits a version\'s welcomes from its other event workflows, and the platform\'s the same way', () => {
    const wf = PLATFORM_EVENT_WORKFLOWS;
    const b = body({ eventWorkflows: { hi: wf.welcome, chase: wf['chase-unredeemed'] } });
    expect(ownWorkflows(b, true).map(([n]) => n)).toEqual(['hi']);
    expect(ownWorkflows(b, false).map(([n]) => n)).toEqual(['chase']);
    expect(platformWorkflows(true).every(([, w]) => w.on === 'assistant-joined')).toBe(true);
    expect(platformWorkflows(false).some(([, w]) => w.on === 'assistant-joined')).toBe(false);
    expect(platformWorkflows(true).length + platformWorkflows(false).length).toBe(Object.keys(wf).length);
  });

  it('copies a platform workflow in under its own name, or the first free one, as a copy rather than a reference', () => {
    expect(copyName(undefined, 'ops-room')).toBe('ops-room');
    expect(copyName({ 'ops-room': PLATFORM_EVENT_WORKFLOWS['ops-room'] }, 'ops-room')).toBe('ops-room-2');
    const { name, workflows } = withPlatformCopy({ 'ops-room': PLATFORM_EVENT_WORKFLOWS['ops-room'] }, 'ops-room');
    expect(name).toBe('ops-room-2');
    expect(Object.keys(workflows)).toEqual(['ops-room', 'ops-room-2']);
    expect(workflows['ops-room-2']).toEqual(PLATFORM_EVENT_WORKFLOWS['ops-room']);
    expect(workflows['ops-room-2']).not.toBe(PLATFORM_EVENT_WORKFLOWS['ops-room']);
  });
});

describe('intent cards', () => {
  const catalog = {
    classification: 'premium', models: { text: [], image: [] }, retrievalReach: [], roles: {},
    packIntents: ['report', 'metric'],
    intents: [
      { key: 'report', description: 'User wants a report.', summary: 'A report', instructions: 'Confirm first.', multiStep: true, machine: 'report' },
      { key: 'metric', description: 'One number.', multiStep: false },
    ],
  } as unknown as ClassificationCatalog;

  it('reads purpose, instructions and machine from the classification\'s pack, and the route from the version', () => {
    const cards = intentCards(body({ models: { byIntent: { report: { primary: 'opus', fallback: 'sonnet' } } } }), catalog);
    expect(cards.map((c) => c.key)).toEqual(['report', 'metric']);
    expect(cards[0]).toMatchObject({ purpose: 'A report', instructions: 'Confirm first.', multiStep: true, machine: 'report', route: { primary: 'opus', fallback: 'sonnet' } });
    // No summary: the purpose is the classifier's description. No route: the default answers.
    expect(cards[1]).toMatchObject({ purpose: 'One number.', multiStep: false });
    expect(cards[1].route).toBeUndefined();
    expect(intentsRunning(catalog, 'report')).toEqual(['report']);
  });

  it('lists the version\'s own pack when it carries one, and a route no pack names', () => {
    const cards = intentCards(body({
      intentPack: { intents: [{ key: 'metric', description: 'Own words.' }] },
      models: { byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } },
    }), catalog);
    expect(cards.map((c) => c.key)).toEqual(['metric', 'image_generation']);
    expect(cards[0].description).toBe('Own words.');
    expect(cards[1].route?.image?.primary).toBe('stability_image_core');
  });

  it('names only the intents of the pack as the pack, never a route no pack names', () => {
    const b = body({ intentPack: { intents: [{ key: 'metric' }] }, models: { byIntent: { greeting: { primary: 'haiku' } } } });
    expect(packIntentKeys(b, catalog)).toEqual(['metric']);
    expect(intentCards(b, catalog).map((c) => c.key)).toEqual(['metric', 'greeting']);
    // No pack of its own: the classification's.
    expect(packIntentKeys(body({ models: { byIntent: { greeting: { primary: 'haiku' } } } }), catalog)).toEqual(['report', 'metric']);
  });
});
