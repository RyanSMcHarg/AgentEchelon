/**
 * EVERY E2E SPEC RUNS IN A VALIDATE PHASE.
 *
 * `node scripts/validate.mjs` is how the suite runs against a deployment, and a spec no phase names is a spec
 * that never runs: seventeen were found that way at once, among them the console-role, flagging, runtime
 * assistant, invitation, export, identity-provider and two latency specs that guides and specs cite as their
 * verification. A spec is registered in a phase, with whatever gate its own header names, or it fails here.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const E2E = path.join(ROOT, 'tests', 'e2e');
const VALIDATE = fs.readFileSync(path.join(ROOT, 'backend', 'scripts', 'validate.mjs'), 'utf8');

describe('every e2e spec runs in a validate phase', () => {
  it('names every spec under tests/e2e in some phase', () => {
    const specs = fs.readdirSync(E2E).filter((f) => f.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(50);
    const unphased = specs.filter((f) => !VALIDATE.includes(`e2e/${f}`));
    expect(unphased).toEqual([]);
  });
});
