/**
 * THE DEMO'S PREMIUM REPORT OFFERS A CHOICE OF TEMPLATES, AND CHANGES NOTHING ELSE (SPEC-DOCUMENT-TEMPLATES
 * FR3a).
 *
 * Premium's pack redeclares the platform `report_generation` workflow with `templates` and
 * `defaultTemplate` on its delivering states, copied by value (`withTemplateChoice`), so every other
 * state and prompt is the platform's. The templates it names are the demo's own files, which `seed-demo`
 * stores; every other demo classification declares no machine and so delivers in the platform's
 * `report` template.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stratumIntentPack, PREMIUM_REPORT_TEMPLATES } from '../demo/intent-packs';
import { parseIntentPack, validateIntentPackBody, taskStateMachines, MAX_INTENT_PACK_BYTES } from '../lambda/src/lib/intent-pack';
import { DEFAULT_TASK_STATE_MACHINES, validateTaskStateMachines, templateChoiceOf } from '../lambda/src/lib/task-state-machines';
import { parseTemplate } from '../lambda/src/lib/document-template';

const platform = DEFAULT_TASK_STATE_MACHINES.report_generation;

describe('the premium demo report offers a choice of templates', () => {
  const stored = stratumIntentPack('premium');
  const raw = JSON.stringify(stored);
  const machine = taskStateMachines(parseIntentPack(raw)).report_generation;

  it('is a storable pack within the whole-pack limit', () => {
    expect(validateIntentPackBody(stored)).toEqual([]);
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_INTENT_PACK_BYTES);
  });

  it('survives the pack read with the choice on both delivering states, and validates', () => {
    for (const state of ['generating', 'revising']) {
      expect(machine.states[state].templates).toEqual([...PREMIUM_REPORT_TEMPLATES]);
      expect(machine.states[state].defaultTemplate).toBe(PREMIUM_REPORT_TEMPLATES[0]);
      expect(machine.states[state].template).toBeUndefined();
    }
    expect(() => validateTaskStateMachines({ ...DEFAULT_TASK_STATE_MACHINES, report_generation: machine })).not.toThrow();
    expect(templateChoiceOf(machine)).toMatchObject({ names: [...PREMIUM_REPORT_TEMPLATES], defaultName: PREMIUM_REPORT_TEMPLATES[0] });
  });

  it('changes nothing but the template declaration', () => {
    const strip = (m: typeof platform) => Object.fromEntries(Object.entries(m.states)
      .map(([k, { template: _t, templates: _ts, defaultTemplate: _d, ...rest }]) => [k, rest]));
    expect(strip(machine)).toEqual(strip(platform));
    expect(machine.initial).toBe(platform.initial);
  });

  it('names templates the demo ships, each parsing to the name it is offered under', () => {
    for (const name of PREMIUM_REPORT_TEMPLATES) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'demo', 'templates', `${name}.md`), 'utf8');
      expect(parseTemplate(source).name).toBe(name);
    }
  });

  it('every other demo classification declares no machine, so it follows the platform report template', () => {
    expect(stratumIntentPack('basic').machines).toBeUndefined();
    expect(stratumIntentPack('standard').machines).toBeUndefined();
  });
});
