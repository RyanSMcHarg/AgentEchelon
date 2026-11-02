/**
 * AN AREA'S UNSAVED EDIT IS ITS OWN PART OF THE DRAFT, LAID OVER THE LATEST SAVE.
 *
 * What it proves: two areas that share a body field (the welcome and the event workflows share `eventWorkflows`; the
 * models and the routing rules share `models`) each keep only their own part of it, so saving one never carries back
 * the other's older value; one patch for several areas keeps every area's edit; the draft the controls start from is
 * the saved draft with the area's edit over it; and only areas holding an edit are listed.
 */
import { describe, it, expect } from 'vitest';
import { combinedPatch, draftWith, rebase, unsavedAreas } from './unsavedAreas';
import type { ProfileDefinitionBody } from '../../services/profileService';

const welcome = (text: string) => ({
  on: 'assistant-joined' as const, initial: 'opening',
  states: { opening: { opening: { text }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' as const } },
});
const chase = (n: number) => ({ on: 'invitation-unredeemed' as const, initial: 'nudge', states: { nudge: { disposition: 'success' as const, wait: n } } }) as never;

const SAVED: ProfileDefinitionBody = {
  modelKey: 'sonnet',
  models: { default: 'sonnet', classifier: 'default', routing: [{ when: 'x', model: 'haiku' }] as never },
  eventWorkflows: { hello: welcome('Hi.'), chase: chase(1) },
};

describe('one area of a shared field', () => {
  it('keeps the welcome edit and takes the event workflows from the latest draft', () => {
    // The welcome edit was made while `chase` waited 1; a save of the events since made it wait 2.
    const edit = { eventWorkflows: { hello: welcome('Hello there.'), chase: chase(1) } };
    const latest = { ...SAVED, eventWorkflows: { hello: welcome('Hi.'), chase: chase(2) } };
    expect(rebase('welcome', latest, edit).eventWorkflows).toEqual({ hello: welcome('Hello there.'), chase: chase(2) });
  });

  it('keeps the events edit and takes the welcomes from the latest draft, and a removed workflow stays removed', () => {
    const edit = { eventWorkflows: { hello: welcome('Hi.') } };
    const latest = { ...SAVED, eventWorkflows: { hello: welcome('Newer.'), chase: chase(1) } };
    expect(rebase('events', latest, edit).eventWorkflows).toEqual({ hello: welcome('Newer.') });
  });

  it('keeps the models edit and takes the routing rules from the latest draft, and the other way round', () => {
    const latest = { ...SAVED, models: { ...SAVED.models, routing: [{ when: 'y', model: 'opus' }] as never } };
    expect(rebase('models', latest, { models: { default: 'haiku', classifier: 'default', routing: SAVED.models!.routing } }).models)
      .toEqual({ default: 'haiku', classifier: 'default', routing: [{ when: 'y', model: 'opus' }] });
    expect(rebase('routing', { ...SAVED, models: { default: 'opus' } }, { models: { default: 'sonnet', routing: [{ when: 'z', model: 'haiku' }] as never } }).models)
      .toEqual({ default: 'opus', routing: [{ when: 'z', model: 'haiku' }] });
  });

  it('leaves an area that shares nothing as it is', () => {
    expect(rebase('identity', SAVED, { persona: 'Short.' })).toEqual({ persona: 'Short.' });
  });
});

describe('several areas in one patch', () => {
  it('keeps both the welcome and the events edits, and a field the result removes is sent as null', () => {
    const patch = combinedPatch(SAVED, {
      welcome: { eventWorkflows: { hello: welcome('Hello there.'), chase: chase(1) } },
      events: { eventWorkflows: { hello: welcome('Hi.') } },
      identity: { persona: null },
    }, ['welcome', 'events', 'identity']);
    expect(patch).toEqual({ eventWorkflows: { hello: welcome('Hello there.') }, persona: null });
  });

  it('sends only the areas asked for', () => {
    expect(combinedPatch(SAVED, { identity: { persona: 'A' }, abilities: { tools: [] } }, ['identity'])).toEqual({ persona: 'A' });
  });
});

describe('what the controls start from', () => {
  it('is the saved draft with the area\'s edit laid over it, or the saved draft when there is none', () => {
    expect(draftWith('identity', SAVED, { persona: 'Edited.' }).persona).toBe('Edited.');
    expect(draftWith('identity', SAVED, undefined)).toBe(SAVED);
  });

  it('lists only the areas holding an edit', () => {
    expect(unsavedAreas({ identity: { persona: 'x' }, welcome: {} })).toEqual(['identity']);
    expect(unsavedAreas({ identity: { persona: 'x' }, abilities: { tools: [] } }, ['abilities', 'models'])).toEqual(['abilities']);
  });
});
