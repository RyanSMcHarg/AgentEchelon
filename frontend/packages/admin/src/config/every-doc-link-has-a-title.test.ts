/**
 * EVERY DOC LINK HAS A TITLE.
 *
 * A guide link renders `admin.docs.title.<link key>` (AdminHelp.tsx), a key built at run time, so the
 * static "every key the code reads has copy" check cannot see it. `messageFlowGuide` had its title filed
 * under `messageFlow`, and the Latency tab printed the raw key where the guide's name belonged.
 */
import { describe, it, expect } from 'vitest';
import { DOC_LINKS, DOC_SECTIONS } from './docLinks';
import en from '../../../shared/src/locales/en.json';

describe('every doc link has a title', () => {
  const titles = (en as { admin: { docs: { title: Record<string, string> } } }).admin.docs.title;

  it('names each link by its own key', () => {
    const missing = Object.keys(DOC_LINKS).filter((key) => !titles[key]);
    expect(missing).toEqual([]);
  });

  // A SECTION OF A GUIDE is titled the same way (`guideSection`): `variables` and `goldenSet` had none, and an
  // assistant's Variables section printed `admin.docs.title.variables` as its guide link.
  it('names each section of a guide by its own key', () => {
    const missing = Object.keys(DOC_SECTIONS).filter((key) => !titles[key]);
    expect(missing).toEqual([]);
  });
});
