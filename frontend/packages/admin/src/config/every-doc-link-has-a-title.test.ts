/**
 * EVERY DOC LINK HAS A TITLE.
 *
 * A guide link renders `admin.docs.title.<link key>` (AdminHelp.tsx), a key built at run time, so the
 * static "every key the code reads has copy" check cannot see it. `messageFlowGuide` had its title filed
 * under `messageFlow`, and the Latency tab printed the raw key where the guide's name belonged.
 */
import { describe, it, expect } from 'vitest';
import { DOC_LINKS } from './docLinks';
import en from '../../../shared/src/locales/en.json';

describe('every doc link has a title', () => {
  const titles = (en as { admin: { docs: { title: Record<string, string> } } }).admin.docs.title;

  it('names each link by its own key', () => {
    const missing = Object.keys(DOC_LINKS).filter((key) => !titles[key]);
    expect(missing).toEqual([]);
  });
});
