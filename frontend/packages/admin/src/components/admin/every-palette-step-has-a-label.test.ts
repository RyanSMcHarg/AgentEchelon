/**
 * Every step the workflow builder's palette offers, every kind the list editor offers to add or change a step to, and
 * every act a preview reports has its label in the copy, so no control or preview line shows its translation key.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PALETTE } from './WorkflowBuilder';
import { kindsFor } from './workflowEdits';
import { EVENT_WORKFLOW_EVENTS, INTENT_TRIGGER } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import en from '../../../../shared/src/locales/en.json';

const copy = en as { admin: { workflowBuilder: Record<string, unknown>; workflowEditor: Record<string, unknown> } };
const isCopy = (group: Record<string, unknown>, key: string) => typeof group[key] === 'string' && !!group[key];

describe('the workflow builder palette', () => {
  it('labels every step and every group it offers', () => {
    const builder = copy.admin.workflowBuilder;
    const missing = PALETTE.flatMap(({ group, items }) => [`group_${group}`, ...items.map((i) => `item_${i}`)])
      .filter((key) => !isCopy(builder, key));
    expect(missing).toEqual([]);
  });
});

describe('the list editor', () => {
  it('labels every kind it offers, on every event, as a step kind and as an add button', () => {
    const editor = copy.admin.workflowEditor;
    const kinds = new Set([...EVENT_WORKFLOW_EVENTS, INTENT_TRIGGER].flatMap((on) => kindsFor(on)));
    expect(kinds.has('meeting')).toBe(true);
    const missing = [...kinds].flatMap((k) => [`kind_${k}`, `add_${k}`]).filter((key) => !isCopy(editor, key));
    expect(missing).toEqual([]);
  });
});

describe('the workflow preview', () => {
  it('labels every act a preview reports', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../../../../backend/lambda/src/lib/workflow-preview.ts'), 'utf8');
    const union = /\bact: ((?:'[a-z_]+'\s*\|?\s*)+);/.exec(source)?.[1] ?? '';
    const acts = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(acts).toContain('meeting');
    const missing = [...acts, 'fallback'].map((a) => `act_${a}`).filter((key) => !isCopy(copy.admin.workflowBuilder, key));
    expect(missing).toEqual([]);
  });
});
