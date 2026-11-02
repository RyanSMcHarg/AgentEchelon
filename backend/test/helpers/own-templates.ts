/**
 * AN ASSISTANT'S OWN WORDING, AS A TURN CARRIES IT: its own message templates on the words object
 * (`withMessageTemplates`). A test names the wording the way a version once did (`{ queuedOne: '...' }`), and the
 * templates are the ones `npm run migrate-legacy-copy` would write for those lines (`legacyCopyPlan`), so a test that
 * proves "the assistant's own words reach this line" exercises the path a turn takes.
 */
import { parseTemplate, type ParsedTemplate } from '../../lambda/src/lib/document-template';
import { legacyCopyPlan } from '../../lambda/src/lib/legacy-copy-migration';
import { withMessageTemplates } from '../../lambda/src/lib/message-lines';

export function ownWords<T extends object = Record<string, never>>(lines: Record<string, unknown>): T {
  const plan = legacyCopyPlan(lines);
  if (plan.refused.length) throw new Error(`ownWords: ${plan.refused.map((r) => `${r.key}: ${r.reason}`).join('; ')}`);
  const own = new Map<string, ParsedTemplate>(plan.templates.map((t) => [t.name, parseTemplate(t.source)]));
  return withMessageTemplates<T>({ own, classwide: new Map() });
}
