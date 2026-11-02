/**
 * THE DOCUMENT TEMPLATES THE PLATFORM SHIPS, AND WHICH CLASSIFICATIONS RECEIVE THEM (SPEC-DOCUMENT-TEMPLATES
 * FR2, FR10).
 *
 * A shipped template is a Markdown file in `default-templates/`, in the same format an operator puts with
 * `npm run template` (front matter naming it, then the body). The platform's own workflows reference them
 * by name: `report_generation`'s delivering states declare `report` (`task-state-machines.ts`).
 *
 * A CLASSIFICATION RECEIVES A TEMPLATE ONLY WHEN ONE OF ITS WORKFLOWS USES IT. Derived at synth, never
 * listed: the intents the classification serves are its deploy-time pack (`-c assistantIntentPack`, where
 * its topology reads one) or the platform pack, less any intent that hands over a document when the
 * registry says the classification produces none (`produces`, the same declaration the capability refusal
 * reads). Each served intent that opens a workflow selects that workflow's machine, from the pack's own
 * machines over the platform's, and the templates its delivering states declare are the classification's.
 * A classification with no templated workflow gets no template, no writer and no read grant.
 *
 * What synth cannot see is a pack that rides a profile version or is seeded after the deploy. A template
 * such a pack declares is put with `npm run template`, as every operator template is; it is read under the
 * same grant, which exists whenever the classification serves a templated workflow at all.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseIntentPack, taskStateMachines, deliveryClassForIntent, needsOf } from '../../lambda/src/lib/intent-pack';
import { templateRefsOfMachine } from '../../lambda/src/lib/task-state-machines';
import { parseTemplate } from '../../lambda/src/lib/document-template';
import { contentIdOf } from '../../lambda/src/lib/profile-bodies';

/** Where the shipped templates live, one Markdown file each. */
export const DEFAULT_TEMPLATE_DIR = path.join(__dirname, 'default-templates');

export interface ShippedTemplate {
  name: string;
  source: string;
  contentHash: string;
}

/**
 * Every template the platform ships, keyed by its declared name. Parsed here, so a shipped template that
 * could not be checked against fails synth rather than a delivery.
 */
export function shippedTemplates(dir: string = DEFAULT_TEMPLATE_DIR): Map<string, ShippedTemplate> {
  const out = new Map<string, ShippedTemplate>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const { name } = parseTemplate(source);
    if (out.has(name)) throw new Error(`default-templates: two files declare the template "${name}"`);
    out.set(name, { name, source, contentHash: contentIdOf(source) });
  }
  return out;
}

/**
 * The template names a classification's workflows declare, as synth can see them.
 *
 * `packJson` is the classification's deploy-time pack, or undefined when it reads none (the platform pack
 * then answers). `producesDocuments` is the registry's `produces(classification, 'document')`.
 */
export function templatesDeclaredFor(packJson: string | undefined, producesDocuments: boolean): string[] {
  const pack = parseIntentPack(packJson?.trim() ? packJson : undefined);
  const machines = taskStateMachines(pack);
  const names = new Set<string>();
  for (const intent of pack.intents) {
    if (!producesDocuments && needsOf(intent) === 'document') continue;
    if (deliveryClassForIntent(intent.key, pack) !== 'TASK_MULTI_STEP') continue;
    for (const ref of templateRefsOfMachine(machines[intent.key])) names.add(ref.name);
  }
  return [...names].sort();
}
