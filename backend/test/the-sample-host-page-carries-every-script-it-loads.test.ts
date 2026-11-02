/**
 * THE SAMPLE HOST PAGE CARRIES EVERY SCRIPT IT LOADS (examples/widget-host).
 *
 * The repository ignores `*.js` as build output (`.gitignore`), so a hand-written script beside an HTML
 * page is silently left out of every commit unless it is excepted: `host.js`, the page's only code, was
 * written and never committed, and the published page loaded nothing. Every local script the page names
 * must be tracked, except `host-config.js`'s deployment value, which the publish writes
 * (`backend/scripts/deploy-frontend.mjs --widget-host`) over the tracked local-run template.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = path.join(ROOT, 'examples', 'widget-host', 'index.html');

describe('the sample host page carries every script it loads', () => {
  it('names only scripts the repository tracks', () => {
    const html = fs.readFileSync(PAGE, 'utf8');
    const local = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]).filter((src) => !/^[a-z]+:\/\//i.test(src));
    expect(local).toEqual(expect.arrayContaining(['host.js', 'host-config.js']));
    const tracked = execFileSync('git', ['ls-files', 'examples/widget-host'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const missing = local.filter((src) => !tracked.includes(`examples/widget-host/${src}`));
    expect(missing).toEqual([]);
  });
});
