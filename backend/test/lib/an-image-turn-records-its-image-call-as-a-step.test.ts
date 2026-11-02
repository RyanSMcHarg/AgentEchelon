/**
 * AN IMAGE TURN RECORDS ITS IMAGE CALL AS A STEP (ADR-064 decision 4).
 *
 * A turn that draws its answer on an image model makes no Converse call, so it pushes no Converse step. Its image call
 * is its step: the model that drew it, the span of the call and its price per image. The Effectiveness step view reads
 * the turn's steps[], so an image turn shows its call and its cost under the task step it started in.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { imageGenerationStep } from '../../lambda/src/lib/analytics-metadata';
import { IMAGE_GEN_MODELS } from '../../lambda/src/lib/image-gen-models';
import { estimateStepCostUsd } from '../../lambda/src/lib/model-rate-table';

const CANVAS = IMAGE_GEN_MODELS.nova_canvas.bedrockModelId;

describe('an image call is a step of its turn', () => {
  it('names the model, the span and the price per image', () => {
    const step = imageGenerationStep({ modelId: CANVAS, startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:04.000Z', imageCount: 1 });
    expect(step).toMatchObject({ stepLabel: 'image-gen', modelId: CANVAS, startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:04.000Z', imageCount: 1 });
    expect(step.estCostUsd).toBe(estimateStepCostUsd({ modelId: CANVAS, imageCount: 1, tokensIn: 0, tokensOut: 0 }));
    expect(typeof step.estCostUsd).toBe('number');
    expect(step).not.toHaveProperty('tools');
  });

  it('an image the guardrail stopped is a call that drew nothing', () => {
    const step = imageGenerationStep({ modelId: CANVAS, startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:01.000Z', imageCount: 0 });
    expect(step.imageCount).toBe(0);
  });

  it('the worker\'s image turn carries that step on its result', () => {
    const src = readFileSync(join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    const branch = src.slice(src.indexOf('if (canGenerateImage) {'), src.indexOf('} else if (imgAtt) {'));
    expect(branch).toMatch(/steps: \[imageGenerationStep\(\{\s+modelId: gen\.modelId,/);
    expect(branch).toMatch(/imageCount: out\.persisted\.length,\s+\}\)\]/);
  });
});
