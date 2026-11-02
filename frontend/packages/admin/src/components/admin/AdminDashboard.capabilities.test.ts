/**
 * EVERY TAB IS GATED ON A CAPABILITY THE CATALOG DEFINES (SPEC-ADMIN-CONSOLE FR0f, FR36).
 *
 * The navigation hides a tab whose capability the console session does not hold. A tab mapped to a key
 * the catalog does not define would be hidden from everyone, admins included, with nothing failing to
 * say so; a tab with no mapping at all would fall open. Both are checked against the catalog the
 * backend grants from, read as source so the two cannot drift.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SECTIONS, TAB_CAPABILITY } from './AdminDashboard';

const catalog = fs.readFileSync(
  path.join(__dirname, '../../../../../../backend/lib/config/admin-capabilities.ts'),
  'utf8',
);
const catalogKeys = new Set([...catalog.matchAll(/^ {2}'([a-z-]+)': \{$/gm)].map((m) => m[1]));

describe('the navigation gate', () => {
  it('reads a catalog with capabilities in it', () => {
    expect(catalogKeys.size).toBeGreaterThan(20);
  });

  it.each(SECTIONS.flatMap((s) => s.tabs))('gates %s on a capability the catalog defines', (tab) => {
    const capability = TAB_CAPABILITY[tab];
    expect(capability, `${tab} has no capability, so it would render for every role`).toBeTruthy();
    expect(catalogKeys.has(capability), `${tab} names ${capability}, which no role can be granted`).toBe(true);
  });
});
