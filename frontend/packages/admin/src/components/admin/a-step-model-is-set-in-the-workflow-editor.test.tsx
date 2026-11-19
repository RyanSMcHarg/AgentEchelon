/**
 * A WORKFLOW STEP'S MODEL IS SET WHERE THE STEP IS EDITED, AND SAYS WHAT IT RUNS ON (ADR-064 decisions B and D).
 *
 * What it proves: the model the console names for a step is the runtime resolver's choice (`routedModel` over
 * `versionRouteStrategy`) for an overridden step, a text step with no override, a document step and an image step; the
 * workflow editor's step model writes `models.byIntent[<intent>].steps[<state>]` through the card's own writer, and the
 * intent card then shows that model on the step.
 */
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@ae/shared/i18n';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import { routedModel } from '../../../../../../backend/lambda/src/lib/resolve-model-plan.ts';
import { versionRouteStrategy } from '../../../../../../backend/lambda/src/lib/model-resolver.ts';
import { getModelCatalog, type BackendModelDefinition, type BackendModelKey } from '../../../../../../backend/lib/config/model-strategy.ts';
import { stepOutputOf } from '../../../../../../backend/lambda/src/lib/step-models.ts';
import { TaskMachineBuilder } from './WorkflowBuilder';
import { StepModelControl, withRoute } from './IntentRouteModels';
import { stepRunsOn } from './stepModelPreview';
import type { ClassificationCatalog, ProfileDefinitionBody, ProfileModels } from '../../services/profileService';

const CATALOG: ClassificationCatalog = {
  classification: 'premium',
  models: { text: ['haiku', 'sonnet', 'opus'], image: ['stability_image_core'], default: 'opus' },
} as ClassificationCatalog;
const REPORT = JSON.parse(JSON.stringify(DEFAULT_TASK_STATE_MACHINES.report_generation)) as TaskStateMachine;
const BODY: Partial<ProfileDefinitionBody> = {
  modelKey: 'sonnet',
  models: {
    default: 'sonnet',
    byIntent: {
      general: { primary: 'haiku' },
      report_generation: { primary: 'sonnet', steps: { generating: { primary: 'opus', fallback: 'sonnet' } } },
      image_generation: { image: { primary: 'stability_image_core' } },
    },
  },
};

/** The runtime's choice for a turn in `step`, resolved as the processor resolves it. */
function runtimeChoice(intent: string, step: string, produces: ReturnType<typeof stepOutputOf>) {
  const byIntent = BODY.models!.byIntent!;
  return routedModel({ classification: 'premium', intent, continuesActiveWork: true, task: { intent, step, produces } }, {
    catalog: getModelCatalog('us-east-1', '') as Record<BackendModelKey, BackendModelDefinition>,
    strategy: versionRouteStrategy({ byIntent }, 'sonnet'),
    models: { selected: [...CATALOG.models.text, ...CATALOG.models.image], default: 'sonnet' },
    routes: byIntent,
  });
}

describe('the model a step is shown on is the runtime\'s choice', () => {
  it.each([
    ['an overridden step', 'generating', 'opus', 'step'],
    ['a text step with no override', 'drafting_outline', 'sonnet', 'route'],
    ['a document step with no override', 'revising', 'sonnet', 'route'],
  ])('%s', (_label, step, model, from) => {
    const produces = stepOutputOf(REPORT.states[step]);
    const shown = stepRunsOn(BODY, CATALOG, 'report_generation', { key: step, produces });
    const runtime = runtimeChoice('report_generation', step, produces);
    expect(shown).toEqual({ modelKey: runtime.primaryModelKey, fallbackKey: runtime.fallbackModelKey ?? undefined, from: runtime.from });
    expect(shown).toMatchObject({ modelKey: model, from });
  });

  it('an image step, on the intent\'s image route', () => {
    expect(stepRunsOn(BODY, CATALOG, 'image_generation', { key: 'generate', produces: 'image' }))
      .toEqual({ modelKey: 'stability_image_core', fallbackKey: undefined, from: 'image' });
  });
});

function Harness() {
  const [models, setModels] = useState<ProfileModels>(BODY.models as ProfileModels);
  const body = { ...BODY, models };
  return (
    <>
      <TaskMachineBuilder name="report_generation" machine={REPORT} tools={[]} onChange={() => undefined}
        renderStepModel={(state, def) => (
          <StepModelControl body={body} catalog={CATALOG} intent="report_generation" step={{ key: state, produces: def.produces }}
            testPrefix={`editor-${state}`} onRoute={(route) => setModels(withRoute(models, 'report_generation', route))} />
        )} />
      <div data-testid="the-card">
        <StepModelControl body={body} catalog={CATALOG} intent="report_generation" step={{ key: 'drafting_outline' }} />
      </div>
      <output data-testid="the-route">{JSON.stringify(models.byIntent?.report_generation)}</output>
    </>
  );
}

describe('the workflow editor sets a step\'s model', () => {
  it('writes route.steps[state], and the intent card shows it', () => {
    render(<Harness />);
    expect(screen.getByTestId('intent-step-report_generation-drafting_outline-model')).toHaveTextContent("Claude Sonnet 4.6, the intent's model");
    fireEvent.click(screen.getByTestId('mb-node-drafting_outline'));
    const select = screen.getByTestId('draft-step-editor-drafting_outline') as HTMLSelectElement;
    // No override names what the step runs on; a text step offers the classification's text models only.
    expect(select.value).toBe('');
    expect(select.options[0].textContent).toBe("Claude Sonnet 4.6, the intent's model");
    expect([...select.options].map((o) => o.value)).toEqual(['', 'haiku', 'sonnet', 'opus']);
    fireEvent.change(select, { target: { value: 'haiku' } });
    expect(JSON.parse(screen.getByTestId('the-route').textContent!)).toEqual({
      primary: 'sonnet',
      steps: { generating: { primary: 'opus', fallback: 'sonnet' }, drafting_outline: { primary: 'haiku' } },
    });
    fireEvent.change(screen.getByTestId('draft-step-editor-drafting_outline-fallback'), { target: { value: 'sonnet' } });
    expect(JSON.parse(screen.getByTestId('the-route').textContent!).steps.drafting_outline).toEqual({ primary: 'haiku', fallback: 'sonnet' });
    expect(screen.getByTestId('intent-step-report_generation-drafting_outline-model')).toHaveTextContent('Claude Haiku 4.5, its own model');
  });

  it('an image step shows the image model it is drawn on and offers no text model', () => {
    const image = JSON.parse(JSON.stringify(DEFAULT_TASK_STATE_MACHINES.image_generation)) as TaskStateMachine;
    const drawing = Object.keys(image.states).find((k) => image.states[k].produces === 'image')!;
    render(<TaskMachineBuilder name="image_generation" machine={image} tools={[]} onChange={() => undefined}
      renderStepModel={(state, def) => (
        <StepModelControl body={BODY} catalog={CATALOG} intent="image_generation" step={{ key: state, produces: def.produces }} onRoute={() => undefined} />
      )} />);
    fireEvent.click(screen.getByTestId(`mb-node-${drawing}`));
    expect(screen.queryByTestId(`draft-step-image_generation-${drawing}`)).toBeNull();
    expect(screen.getByTestId(`intent-step-image_generation-${drawing}-model`)).toHaveTextContent("the intent's image model");
  });
});
