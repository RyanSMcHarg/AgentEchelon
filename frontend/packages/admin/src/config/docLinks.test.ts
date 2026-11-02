/**
 * EVERY DOCUMENTATION LINK IN THE CONSOLE POINTS AT A FILE THAT EXISTS.
 *
 * Four of these used to point at blog posts on mcharg.site, and all four were dead. Nobody noticed,
 * and the reason is worth pinning a test on: that site is a client-rendered SPA with a catch-all
 * route, so a slug that does not exist returns HTTP 200 with the site's generic title. Every
 * automated check a link checker performs comes back green. The links were confirmed dead only by
 * comparing the prerendered `<title>` of each against a known-good slug and a deliberately bogus one.
 *
 * A link that cannot be verified is a link that rots silently, so the registry now points only at
 * paths in this repo - which this test resolves on disk. The check is cheap and total: it is the
 * whole registry, not a sample, and it runs offline, so it cannot be flaky and cannot be skipped
 * when the network is unavailable.
 *
 * WHAT THIS DOES NOT PROVE: that the file is published on the public GitHub repo. That is a
 * different fact, checked once when a link is added (see the note in docLinks.ts). This proves the
 * path is real and still spelled that way, which is the failure that actually happens - a doc gets
 * renamed or moved and every console link to it becomes a 404.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DOC_LINKS } from './docLinks';

/** The repo root, from this file: src/config -> src -> admin -> packages -> frontend -> root. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const BLOB_PREFIX = 'https://github.com/RyanSMcHarg/AgentEchelon/blob/main/';

const entries = Object.entries(DOC_LINKS) as Array<[string, string]>;

describe('the documentation registry', () => {
  it('has entries, so an empty object cannot pass the checks below vacuously', () => {
    expect(entries.length).toBeGreaterThan(5);
  });

  it.each(entries)('%s resolves to a file that exists in this repo', (_key, url) => {
    expect(url.startsWith(BLOB_PREFIX)).toBe(true);
    const repoPath = url.slice(BLOB_PREFIX.length);
    const onDisk = path.join(REPO_ROOT, repoPath);
    // The message names the path, because "false is not true" sends the next reader looking in the
    // wrong place - the bug is nearly always a doc that moved, not a bug in this test.
    expect(fs.existsSync(onDisk), `${repoPath} is linked from the console but does not exist`).toBe(true);
    expect(fs.statSync(onDisk).isFile()).toBe(true);
  });

  it('links to no host whose 404 is invisible', () => {
    // mcharg.site serves its SPA shell for any path, so a dead link there is indistinguishable from
    // a live one without rendering the page. Naming it keeps the reason attached to the rule: this
    // is not a preference for GitHub, it is a refusal to link somewhere that cannot report a 404.
    for (const [, url] of entries) {
      expect(url).not.toContain('mcharg.site');
    }
  });

  it('points every link at a doc, not at code', () => {
    // A link from the console is for a person who wants an explanation. Source is not that, and a
    // line-numbered source link is the fastest kind of link to rot.
    for (const [key, url] of entries) {
      const repoPath = url.slice(BLOB_PREFIX.length);
      expect(repoPath.startsWith('docs/'), `${key} points outside docs/`).toBe(true);
      expect(repoPath.endsWith('.md'), `${key} does not point at a document`).toBe(true);
      expect(url).not.toMatch(/#L\d/);
    }
  });

  it('gives each entry its own target, so a topic is not quietly aliased to another', () => {
    // Two keys once shared one URL, which is how "message delivery" silently became "message flow"
    // for anybody who followed it.
    const urls = entries.map(([, url]) => url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
