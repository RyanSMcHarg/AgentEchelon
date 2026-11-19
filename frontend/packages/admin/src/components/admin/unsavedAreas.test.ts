/**
 * AN AREA'S UNSAVED EDIT IS ITS OWN PART OF THE DRAFT, LAID OVER THE LATEST SAVE.
 *
 * What it proves: the workflows area owns every workflow, the welcome included, so an edit to a welcome is saved with it;
 * two areas that share a body field (the models and the routing rules share `models`) each keep only their own part of it, so saving one never carries back
 * the other's older value; one patch for several areas keeps every area's edit; the draft the controls start from is
 * the saved draft with the area's edit over it; and only areas holding an edit are listed.
 */
import { describe, it, expect } from 'vitest';
import { combinedPatch, draftWith, rebase, rebaseOnto, unsavedAreas } from './unsavedAreas';
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
  it('keeps the workflows edit whole, the welcome in it included, and a removed workflow stays removed', () => {
    // The builder edits every workflow, so a welcome edited there is saved with the rest rather than taken from the draft.
    const edit = { eventWorkflows: { hello: welcome('Hello there.') } };
    const latest = { ...SAVED, eventWorkflows: { hello: welcome('Newer.'), chase: chase(1) } };
    expect(rebase('events', latest, edit).eventWorkflows).toEqual({ hello: welcome('Hello there.') });
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
  it('keeps the workflows and the identity edits, and a field the result removes is sent as null', () => {
    const patch = combinedPatch(SAVED, {
      events: { eventWorkflows: { hello: welcome('Hello there.') } },
      identity: { persona: null },
    }, ['events', 'identity']);
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
    expect(unsavedAreas({ identity: { persona: 'x' }, events: {} })).toEqual(['identity']);
    expect(unsavedAreas({ identity: { persona: 'x' }, abilities: { tools: [] } }, ['abilities', 'models'])).toEqual(['abilities']);
  });
});

describe('carrying unsaved edits onto a draft saved elsewhere since', () => {
  const nudge = (n: number) => ({ on: 'invitation-unredeemed' as const, initial: 'nudge', states: { nudge: { disposition: 'success' as const, wait: n } } }) as never;

  it("keeps the workflows this person changed and takes every other workflow from the newer draft", () => {
    // Started from SAVED: this person edited the welcome and removed the chase; the other writer added a nudge.
    const edit = { eventWorkflows: { hello: welcome('Mine.') } };
    const newer = { ...SAVED, eventWorkflows: { hello: welcome('Hi.'), chase: chase(1), nudge: nudge(2) } };
    const { unsaved, overlaps } = rebaseOnto({ events: edit }, SAVED, newer);
    expect(unsaved.events?.eventWorkflows).toEqual({ hello: welcome('Mine.'), nudge: nudge(2) });
    expect(overlaps).toEqual([]);
  });

  it('names a workflow both changed, and keeps this person\'s version of it', () => {
    const edit = { eventWorkflows: { hello: welcome('Mine.'), chase: chase(1) } };
    const newer = { ...SAVED, eventWorkflows: { hello: welcome('Theirs.'), chase: chase(1) } };
    const { unsaved, overlaps } = rebaseOnto({ events: edit }, SAVED, newer);
    expect(unsaved.events?.eventWorkflows).toEqual({ hello: welcome('Mine.'), chase: chase(1) });
    expect(overlaps).toEqual([{ area: 'events', fields: ['eventWorkflows.hello'] }]);
  });

  it('names a field of another area the newer draft also changed, and keeps the edit for the person to decide', () => {
    const before = { ...SAVED, persona: 'Old.' };
    const newer = { ...SAVED, persona: 'Theirs.' };
    const { unsaved, overlaps } = rebaseOnto({ identity: { persona: 'Mine.' } }, before, newer);
    expect(unsaved.identity).toEqual({ persona: 'Mine.' });
    expect(overlaps).toEqual([{ area: 'identity', fields: ['persona'] }]);
  });

  it('names nothing where the newer draft left the field alone', () => {
    const newer = { ...SAVED, tools: ['search_context'] };
    const { unsaved, overlaps } = rebaseOnto({ identity: { persona: 'Mine.' } }, SAVED, newer);
    expect(unsaved.identity).toEqual({ persona: 'Mine.' });
    expect(overlaps).toEqual([]);
  });

  it('drops an edit that says nothing the newer draft does not already say', () => {
    const newer = { ...SAVED, persona: 'Same.' };
    const { unsaved, overlaps } = rebaseOnto({ identity: { persona: 'Same.' } }, SAVED, newer);
    expect(unsaved).toEqual({});
    expect(overlaps).toEqual([]);
  });
});
