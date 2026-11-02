/**
 * The platform's shipped document templates as a turn holds them once loaded (`TurnTemplates`), for a
 * test that drives a platform workflow whose delivering step declares one. The processor loads them from
 * the store before the turn runs; a test hands them over directly, parsed from the same files the deploy
 * writes (`lib/config/default-templates/`).
 */
import { shippedTemplates } from '../../lib/config/default-templates';
import { parseTemplate, type TurnTemplates } from '../../lambda/src/lib/document-template';

export const SHIPPED_TURN_TEMPLATES: TurnTemplates = Object.fromEntries(
  [...shippedTemplates()].map(([name, t]) => [name, { name, contentHash: t.contentHash, template: parseTemplate(t.source) }]),
);
