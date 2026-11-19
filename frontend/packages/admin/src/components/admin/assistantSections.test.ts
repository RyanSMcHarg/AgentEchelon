/**
 * AN ASSISTANT'S PAGE, READ AS ITS SECTIONS: the menu's changed marks are the draft's own diff, a platform workflow is
 * copied in under a free name, and an intent's card joins the version's pack, the classification's and the version's
 * routes, so every model a version chooses is on a card.
 */
import { describe, it, expect } from 'vitest';
import { SHIPPED_EVENT_WORKFLOWS } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { DRAFT_AREAS } from './draftAreas';
import { CREATION_STEPS, SECTIONS, SECTION_AREAS, WIZARD_SECTIONS, changedSections, changesOtherFields, creationSteps, copyName, inheritedImageModel, intentCards, intentsRunning, ownWorkflows, packIntentKeys, platformCopyConflict, platformIntentRows, platformRouteServing, platformWorkflows, platformWorkflowsRunByDefault, refusedIntentKeys, workflowSelected, withPlatformCopy } from './assistantSections';
import { DEFAULT_INTENT_PACK } from '../../../../../../backend/lambda/src/lib/intent-pack-taxonomy.ts';
import { platformRoutesServedOn } from '../../../../../../backend/lambda/src/lib/model-resolver.ts';
import { versionEventWorkflowsErrors, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
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

  it('says when the draft changes a field no section edits, which the count would otherwise miss', () => {
    const active = body({ persona: 'a' });
    const onlyOther = body({ persona: 'a', systemPromptAddendum: 'I do not reach payroll.' });
    expect(changedSections(active, onlyOther).size).toBe(0);
    expect(changesOtherFields(active, onlyOther)).toBe(true);
    expect(changesOtherFields(active, body({ persona: 'b' }))).toBe(false);
    expect(changesOtherFields(active, null)).toBe(false);
  });
});

describe('the creation wizard steps', () => {
  it('are the two that make the assistant, then the editable sections in the page order, then the review', () => {
    expect(CREATION_STEPS).toEqual(['assistant', 'start', 'behavioral', 'scope', 'workflows', 'messages', 'tools', 'settings', 'review']);
    expect(SECTIONS.filter((s) => (WIZARD_SECTIONS as readonly string[]).includes(s))).toEqual([...WIZARD_SECTIONS]);
    // A section step takes the page's own title; the others the create's.
    expect(creationSteps((k) => k).map((s) => s.label)).toEqual([
      'admin.create.step.assistant', 'admin.create.step.start',
      'admin.assistantPage.sections.behavioral.title', 'admin.assistantPage.sections.scope.title',
      'admin.assistantPage.sections.workflows.title', 'admin.assistantPage.sections.messages.title', 'admin.assistantPage.sections.tools.title', 'admin.assistantPage.sections.settings.title', 'admin.create.step.review',
    ]);
  });
});

describe('workflows by ownership', () => {
  it('splits a version\'s welcomes from its other event workflows, and the platform\'s the same way', () => {
    const wf = SHIPPED_EVENT_WORKFLOWS;
    const b = body({ eventWorkflows: { hi: wf.welcome, chase: wf['chase-unredeemed'] } });
    expect(ownWorkflows(b, true).map(([n]) => n)).toEqual(['hi']);
    expect(ownWorkflows(b, false).map(([n]) => n)).toEqual(['chase']);
    expect(platformWorkflows(true).every(([, w]) => w.on === 'assistant-joined')).toBe(true);
    expect(platformWorkflows(false).some(([, w]) => w.on === 'assistant-joined')).toBe(false);
    expect(platformWorkflows(true).length + platformWorkflows(false).length).toBe(Object.keys(wf).length);
  });

  it('copies a platform workflow in under its own name, or the first free one, as a copy rather than a reference', () => {
    expect(copyName(undefined, 'ops-room')).toBe('ops-room');
    expect(copyName({ 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'] }, 'ops-room')).toBe('ops-room-2');
    const { name, workflows } = withPlatformCopy({ 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'] }, 'ops-room');
    expect(name).toBe('ops-room-2');
    expect(Object.keys(workflows)).toEqual(['ops-room', 'ops-room-2']);
    expect(workflows['ops-room-2']).toEqual(SHIPPED_EVENT_WORKFLOWS['ops-room']);
    expect(workflows['ops-room-2']).not.toBe(SHIPPED_EVENT_WORKFLOWS['ops-room']);
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
    expect(cards[0]).toMatchObject({ purpose: 'User wants a report.', instructions: 'Confirm first.', multiStep: true, machine: 'report', route: { primary: 'opus', fallback: 'sonnet' } });
    // No route: the default answers.
    expect(cards[1]).toMatchObject({ purpose: 'One number.', multiStep: false });
    expect(cards[1].route).toBeUndefined();
    expect(intentsRunning(body({}), catalog, 'report')).toEqual(['report']);
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

describe('which platform workflows run, and copying one in', () => {
  it('runs the welcome, the join recap and drift by default, and every other platform workflow only once copied in', () => {
    const runs = platformWorkflowsRunByDefault();
    expect([...runs].sort()).toEqual(['drift', 'join-recap', 'welcome']);
    for (const name of ['ops-room', 'opening-and-subject', 'incident-watch', 'chase-unredeemed']) expect(runs.has(name)).toBe(false);
  });

  it('a welcome copied over the version\'s untyped welcome replaces it, so the version is not refused', () => {
    const own: Record<string, EventWorkflow> = { 'my-welcome': JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS.welcome)) };
    expect(platformCopyConflict(own, 'opening-and-subject')).toBe('my-welcome');
    const beside = withPlatformCopy(own, 'opening-and-subject').workflows;
    expect(versionEventWorkflowsErrors(beside).join('\n')).toMatch(/that name no type/);
    const replaced = withPlatformCopy(own, 'opening-and-subject', { replace: true });
    expect(replaced).toMatchObject({ name: 'opening-and-subject', replaced: 'my-welcome' });
    expect(Object.keys(replaced.workflows)).toEqual(['opening-and-subject']);
    expect(versionEventWorkflowsErrors(replaced.workflows)).toEqual([]);
    // A copy that conflicts with nothing replaces nothing.
    expect(platformCopyConflict(own, 'ops-room')).toBeUndefined();
    expect(Object.keys(withPlatformCopy(own, 'ops-room', { replace: true }).workflows)).toEqual(['my-welcome', 'ops-room']);
  });
});

describe('the intents a version serves, read as the runtime resolves them', () => {
  const catalog = {
    classification: 'premium', models: { text: ['haiku', 'sonnet'], image: ['stability_image_core'], default: 'sonnet' }, retrievalReach: [], roles: {},
    workflows: [
      { key: 'report_generation', source: 'platform', required: false, initial: 'a', states: [] },
      { key: 'queue_drain', source: 'platform', required: true, initial: 'a', states: [] },
    ],
    packIntents: ['report'],
    intents: [{ key: 'report', description: 'A report.', multiStep: true, machine: 'report_generation', tools: ['search_context', 'make_chart'] }],
    platformIntents: [{ key: 'greeting', answersThroughGeneral: true }, { key: 'general', answersThroughGeneral: false }],
  } as unknown as ClassificationCatalog;

  it('resolves a version pack that extends the platform pack: its overrides over the inherited intents, none of them lost', () => {
    const b = body({ intentPack: { extends: 'default', intents: [{ key: 'report_generation', instructions: 'Own instructions.' } as never] } });
    const cards = intentCards(b, catalog);
    // Every inherited intent is served, in the order the runtime resolves them (the override first).
    expect([...cards.map((c) => c.key)].sort()).toEqual(DEFAULT_INTENT_PACK.intents.map((i) => i.key).sort());
    const report = cards.find((c) => c.key === 'report_generation')!;
    const inherited = DEFAULT_INTENT_PACK.intents.find((i) => i.key === 'report_generation')!;
    // The override changes only what it says; the rest is the platform intent's, and none of the classification's.
    expect(report).toMatchObject({ instructions: 'Own instructions.', description: inherited.description, multiStep: true, machine: 'report_generation', needs: 'document' });
    expect(cards.some((c) => c.key === 'report')).toBe(false);
    expect(refusedIntentKeys(b, catalog)).toEqual([]);
  });

  it('refuses the platform intents the served pack leaves out', () => {
    const b = body({ intentPack: { intents: [{ key: 'metric', description: 'One number.' }] } });
    expect(refusedIntentKeys(b, catalog)).toEqual(DEFAULT_INTENT_PACK.intents.map((i) => i.key));
    // No pack of its own: the classification's pack is the one served.
    expect(refusedIntentKeys(body({}), catalog)).toEqual(DEFAULT_INTENT_PACK.intents.map((i) => i.key));
    expect(refusedIntentKeys(body({}), { ...catalog, intents: undefined } as ClassificationCatalog)).toEqual([]);
  });

  it('reads the workflow selection as the router gates it: empty opens all, the queue is never removed', () => {
    expect(workflowSelected(body({}), catalog, 'report_generation')).toBe(true);
    expect(workflowSelected(body({ workflows: [] }), catalog, 'report_generation')).toBe(true);
    expect(workflowSelected(body({ workflows: ['image_generation'] }), catalog, 'report_generation')).toBe(false);
    expect(workflowSelected(body({ workflows: ['image_generation'] }), catalog, 'queue_drain')).toBe(true);
    expect(intentCards(body({ workflows: ['image_generation'] }), catalog)[0]).toMatchObject({ machine: 'report_generation', machineSelected: false });
    expect(intentCards(body({ workflows: ['report_generation'] }), catalog)[0].machineSelected).toBe(true);
  });

  it("offers an intent's tools within the version's allowlist", () => {
    expect(intentCards(body({ tools: ['search_context'] }), catalog)[0].tools).toEqual(['search_context']);
    expect(intentCards(body({}), catalog)[0].tools).toEqual(['search_context', 'make_chart']);
    expect(intentCards(body({ intentPack: { intents: [{ key: 'metric' }] } }), catalog)[0].tools).toBeUndefined();
  });

  it("counts only a concrete text model as a platform intent's own route", () => {
    const own = (route: Record<string, unknown>) => platformIntentRows(body({ models: { byIntent: { report: { primary: 'sonnet' }, greeting: route } } }), catalog)
      .find((r) => r.key === 'greeting')!.answers;
    expect(own({ primary: 'haiku' })).toBe('own');
    expect(own({ primary: 'default' })).toBe('general');
    expect(own({ image: { primary: 'stability_image_core' } })).toBe('general');
  });

  it('says the platform routes serve while the version names no text route of its own', () => {
    const none = body({ models: { default: 'haiku', byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } } });
    const seeded = platformRoutesServedOn('haiku');
    expect(platformRouteServing(none, catalog, 'general')).toEqual({ ...seeded.general, via: 'own' });
    // Once it names one, its routes are the whole strategy.
    expect(platformRouteServing(body({ models: { byIntent: { report: { primary: 'sonnet' } } } }), catalog, 'general')).toBeUndefined();
    // A base model that follows the classification serves the platform routes on the classification default.
    expect(platformRouteServing(body({ modelKey: 'default', models: {} }), catalog, 'general')).toEqual({ ...platformRoutesServedOn('sonnet').general, via: 'own' });
  });

  it('names the image model an intent that needs one inherits from the image_generation route', () => {
    const b = body({ models: { byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } } });
    expect(inheritedImageModel(b, 'poster')).toBe('stability_image_core');
    expect(inheritedImageModel(b, 'image_generation')).toBeUndefined();
    expect(inheritedImageModel(body({}), 'poster')).toBeUndefined();
  });
});

describe('a version\'s own machine', () => {
  it('runs the multi-step intent it is keyed by, though the classification catalog has no machine by that name', () => {
    const own = body({
      intentPack: {
        extends: 'default',
        intents: [{ key: 'site_visit', description: 'Plan a site visit', keywords: [], delivery: 'TASK_MULTI_STEP' }],
        machines: { site_visit: { initial: 'plan', states: { plan: { transitions: [], terminal: 'success' } } } },
      } as never,
    });
    const catalog = { classification: 'premium', workflows: [] } as unknown as ClassificationCatalog;
    expect(intentsRunning(own, catalog, 'site_visit')).toEqual(['site_visit']);
  });
});
