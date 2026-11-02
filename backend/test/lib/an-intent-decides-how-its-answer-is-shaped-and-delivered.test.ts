/**
 * AN INTENT DECIDES HOW ITS ANSWER IS SHAPED AND DELIVERED (SPEC-CONFIGURABLE-INTENT-PACK FR17-FR22;
 * `lambda/src/lib/intent-answer.ts`).
 *
 * The pack decides what an assistant answers, and now how: instructions in the prompt, and prescriptive
 * guidance code enforces - temperature, message or file decided from the produced answer, required
 * sections and shape checks, all validated at activation.
 */
import {
  intentAnswerPrompt, deliverAsFile, fileForAnswer, answerShapeIssues, answerGuidanceErrors, coerceAnswerGuidance,
} from '../../lambda/src/lib/intent-answer';
import { DEFAULT_INTENT_PACK, validateIntentPackBody, type IntentPack } from '../../lambda/src/lib/intent-pack';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { readFileSync } from 'fs';
import { join } from 'path';

const pack: IntentPack = DEFAULT_INTENT_PACK;

describe('the prompt comes from the pack', () => {
  it('a declared intent is told it is offered, with its instructions and its required shape', () => {
    const text = intentAnswerPrompt('code_review', pack);
    expect(text).toContain('## HOW TO ANSWER THIS REQUEST');
    expect(text).toContain('You offer this');
    expect(text).toContain('ranked by severity');
    expect(text).toContain('## ANSWER SHAPE');
    expect(text).toContain('Findings / What is good');
  });

  it('a general turn carries only what the pack offers', () => {
    const text = intentAnswerPrompt('general', pack);
    expect(text).not.toContain('HOW TO ANSWER');
    expect(text).toContain('## WHAT YOU OFFER');
  });

  it('every platform intent carries instructions', () => {
    for (const d of DEFAULT_INTENT_PACK.intents) expect([d.key, !!d.instructions]).toEqual([d.key, true]);
  });
});

describe('a snippet and a code deliverable are separate intents', () => {
  const snippet = pack.intents.find((d) => d.key === 'code_generation')!;
  const deliverable = pack.intents.find((d) => d.key === 'code_delivery')!;

  it('a snippet is one reply posted in the message', () => {
    expect(snippet.delivery).toBe('PLACEHOLDER_UPDATE');
    expect(deliverAsFile(snippet.answer, '```ts\n' + 'x\n'.repeat(500) + '```')).toBe(false);
  });

  it('a code deliverable is a task whose machine delivers a file named by its language', () => {
    expect(deliverable.delivery).toBe('TASK_MULTI_STEP');
    expect(DEFAULT_TASK_STATE_MACHINES.code_delivery.states.generating.produces).toBe('document');
    const file = fileForAnswer(deliverable.answer, 'Here it is.\n```python\nprint("hi")\n```\n');
    expect(file).toEqual({ content: 'print("hi")\n', extension: 'py', contentType: 'text/plain; charset=utf-8' });
  });

  it('a design is a task with an outline step; a design review is one reply', () => {
    expect(pack.intents.find((d) => d.key === 'technical_design')!.delivery).toBe('TASK_MULTI_STEP');
    expect(Object.keys(DEFAULT_TASK_STATE_MACHINES.technical_design.states)).toContain('drafting_outline');
    expect(pack.intents.find((d) => d.key === 'design_review')!.delivery).toBe('PLACEHOLDER_UPDATE');
  });

  it('a delivering state never promises a file: the platform decides that from the answer', () => {
    // A short result posts in the message (the 400-character floor), so a prompt that says "it is
    // delivered as a file" makes the model claim an attachment that never arrives.
    for (const key of ['code_delivery', 'technical_design']) {
      for (const st of Object.values(DEFAULT_TASK_STATE_MACHINES[key].states)) {
        expect(st.prompt || '').not.toMatch(/\bis delivered as a (file|document)\b/i);
      }
    }
  });

  it('every state of the new machines declares its own prompt', () => {
    for (const key of ['code_delivery', 'technical_design']) {
      for (const [name, st] of Object.entries(DEFAULT_TASK_STATE_MACHINES[key].states)) {
        if (!st.terminal) expect([key, name, !!st.prompt]).toEqual([key, name, true]);
      }
    }
  });
});

describe('message or file is decided by code, from what was produced', () => {
  const auto = { form: 'auto' as const, fileAbove: { chars: 100 }, fileType: 'markdown' as const };
  it('auto stays in the message under the threshold and becomes a file over it', () => {
    expect(deliverAsFile(auto, 'short')).toBe(false);
    expect(deliverAsFile(auto, 'x'.repeat(101))).toBe(true);
  });
  it('a code answer with more than one block is a file', () => {
    expect(deliverAsFile({ form: 'auto', fileAbove: { lines: 999 }, fileType: 'code' }, '```ts\na\n```\n```ts\nb\n```')).toBe(true);
  });
  it('no form leaves the caller\'s previous rule in place', () => {
    expect(deliverAsFile(undefined, 'anything')).toBeUndefined();
  });
});

describe('shape checks', () => {
  it('flags a missing code block, missing sections, and a claimed file', () => {
    expect(answerShapeIssues({ require: ['code-block'] }, 'no code here').map((i) => i.kind)).toEqual(['code_block']);
    expect(answerShapeIssues({ sections: ['Findings', 'What is good'], require: ['sections'] }, 'What is good\nFindings').map((i) => i.kind)).toEqual(['sections']);
    expect(answerShapeIssues({ require: ['no-file-claim'] }, 'I have attached the file for you.').map((i) => i.kind)).toEqual(['file_claim']);
  });
  it('passes a well-shaped answer', () => {
    expect(answerShapeIssues({ sections: ['Findings', 'What is good'], require: ['sections', 'code-block'] }, 'Findings\n```js\nx\n```\nWhat is good')).toEqual([]);
  });
});

describe('guidance is validated at activation and coerced on read', () => {
  it('refuses a bad field and names the fix', () => {
    expect(answerGuidanceErrors({ temperature: 2 }, 'i')).toEqual(['i.answer.temperature must be a number from 0 to 1']);
    expect(answerGuidanceErrors({ form: 'auto' }, 'i')).toEqual(["i.answer.form 'auto' needs fileAbove to decide by"]);
    expect(answerGuidanceErrors({ require: ['sections'] }, 'i')).toEqual(["i.answer.require names 'sections' but the intent declares no answer.sections"]);
    expect(answerGuidanceErrors({ colour: 'red' }, 'i')[0]).toContain('not a known field');
  });
  it('the platform defaults pass the same gate', () => {
    expect(validateIntentPackBody(DEFAULT_INTENT_PACK)).toEqual([]);
  });
  it('a malformed field is dropped on read rather than breaking a turn', () => {
    expect(coerceAnswerGuidance({ temperature: 5, form: 'message' })).toEqual({ form: 'message' });
  });
});

describe('the intent temperature reaches every model path', () => {
  it('the external-provider call sends the turn temperature, not the deployment default', () => {
    // Source scan: the external path is a network call with no seam a unit test can drive.
    const src = readFileSync(join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    const call = src.slice(src.indexOf('await invokeExternalLlm(cnCfg'), src.indexOf('await invokeExternalLlm(cnCfg') + 400);
    expect(call).toContain('temperature: invokeConfig.temperature');
    expect(call).not.toContain('CONFIG.temperature');
  });
});
