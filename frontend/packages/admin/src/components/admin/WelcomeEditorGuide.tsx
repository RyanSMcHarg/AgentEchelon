/**
 * HOW AN ASSISTANT'S OPENING IS MADE, BESIDE THE BOX THAT WRITES IT.
 *
 * Two answers, in the order a person needs them:
 *
 *   - what the built-in opening is made of, which is what a blank Opening text gives;
 *   - a preview against a sample conversation, so the rule is seen working rather than read about.
 *
 * THE PREVIEW IS THE ROUTER'S OWN SELECTION AND RENDERER (W1). `welcomeWorkflowOf` picks the welcome workflow a room of
 * this type runs, `welcomePlan` finds its opening step, `selectOpening` reads its text and orientation, and
 * `composeOpening` renders them, in the same pure modules the router posts a welcome from
 * (`backend/lambda/src/lib/event-workflow.ts`, `welcome-orientation.ts`). What the preview shows for a sample
 * conversation is what the router posts in one, built-in opening included. A welcome whose plan runs its own steps
 * (`welcomePlan` with `runs`) is posted step by step by the router, so the preview names those steps, and shows the
 * composed opening only where one of them is the opening step that posts it; the intake follows the opening only where the join says the welcome and owns the room's arrivals
 * (`arrivalWelcomeOwner`), as the router starts it.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  composeOpening,
  selectOpening,
  withDeploymentOpening,
  type WelcomeOrientation,
} from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import { arrivalWelcomeOwner, openedWorkflowOf, welcomePlan, welcomeWorkflowOf, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { routerHeldVariables, type PublishedVariables, type VersionVariable } from '../../../../../../backend/lambda/src/lib/variables.ts';
import { workflowSteps } from './eventWorkflowPreview';

type Sample = 'none' | 'topic' | 'event' | 'continued';

/** What the preview shows for one draft's welcome workflows, conversation type and sample conversation. */
export interface WelcomePreview {
  /** The opening the router posts. */
  content: string;
  /** Which opening produced it. */
  applies: 'type' | 'default' | 'builtIn' | 'emptyTemplate' | 'deployment' | 'openedBy' | 'runs';
  /** True when the text is built from the deployment's copy: the opening sets no text and the copy applies to this assistant. */
  deploymentCopy: boolean;
  /** True when the opening sets fields of its own (its suggested prompts), laid over the deployment's copy. */
  ownFields: boolean;
  /** The workflow that greets a room of this type when it opens, where one does; the join then posts nothing. */
  openedBy?: string;
  /** The steps the welcome runs, in the order a run reaches them, when its plan runs them. */
  runs?: string[];
  /** True when the welcome has an opening step, which posts `content`; a welcome that runs without one posts no opening. */
  opens: boolean;
  /** True when the onboarding intake follows the opening: the join says the welcome and owns the room's arrivals. */
  intake: boolean;
}

/** What the room's opening is built from beyond the draft: the deployment's copy, and the assistant's own name. */
export interface WelcomePreviewContext {
  /** The deployment's welcome orientation for the classification, as the router reads it. */
  deployment?: WelcomeOrientation;
  /** Whether this assistant is the classification's primary: the deployment's orientation applies to it alone. */
  isPrimary?: boolean;
  /** The assistant's display name, for `{{assistantName}}`. */
  assistantName?: string;
  /** The assistant's role, for `{{role}}`. */
  role?: string;
  /** The classification's published variable sources and the version's own variables, for an opening that names one. */
  published?: PublishedVariables;
  variables?: Readonly<Record<string, VersionVariable>>;
  /** The classification, a value the router holds for a variable that names it. */
  classification?: string;
  /** Every workflow of the version, for whether a workflow that opens the room greets it in place of this one. */
  allWorkflows?: Record<string, EventWorkflow> | null;
  /** What the assistant asks a person it has not met after the opening, in a one-person conversation, where it asks. */
  intake?: { greeting?: string; questions: string[]; source: 'version' | 'deployment' };
  /** True when the deployment's settings could not be read, so the preview may not be what the room is greeted with. */
  unread?: boolean;
}

/** The opening the router posts for these draft workflows, in this kind of conversation, with these conversation fields. */
export function previewWelcome(
  workflows: Record<string, EventWorkflow> | null | undefined,
  conversationType: string | undefined,
  conversation: WelcomeOrientation,
  role?: string,
  context: WelcomePreviewContext = {},
): WelcomePreview {
  const type = conversationType || undefined;
  const welcome = welcomeWorkflowOf(workflows, type);
  const plan = welcomePlan(welcome.workflow);
  const own = selectOpening(plan.opening);
  // THE ROUTER'S PRECEDENCE (`loadWelcomeFor`): the opening's own fields over the deployment's, field by field, where the
  // deployment's copy applies to this assistant (its classification's primary); with no text, the composed opening.
  const deploymentApplies = context.isPrimary !== false && !!context.deployment;
  const orientation = withDeploymentOpening(own?.orientation, deploymentApplies ? context.deployment : undefined) ?? {};
  // THE VARIABLES THE ROUTER RESOLVES, through its own function (`routerHeldVariables`): the version's, with the two values
  // every router holds. Any other source has no value at a join, so its fallback is said, as it is in the room.
  const vars = routerHeldVariables(context.variables, {
    ...(context.classification ? { classification: context.classification } : {}),
    ...(type ? { conversationType: type } : {}),
  });
  const opening = composeOpening(own?.template, { ...orientation, ...conversation },
    { role, ...(context.assistantName ? { name: context.assistantName } : {}) }, vars);
  const typed = !!type && (welcome.workflow.types ?? []).includes(type);
  // A ROOM A WORKFLOW OPENS IS GREETED BY THAT WORKFLOW, and the join posts nothing (`arrivalWelcomeOwner`).
  const all = context.allWorkflows ?? workflows;
  const owner = arrivalWelcomeOwner({ conversationType: type, own: all });
  const openedBy = type && owner === 'conversation-opened' ? openedWorkflowOf(all, type)?.name : undefined;
  // A WELCOME THAT RUNS ITS STEPS is posted by the router step by step, the intent posting nothing (`welcomePlan`).
  const runs = plan.runs ? workflowSteps(welcome.workflow).filter((s) => !s.disposition && !s.unreached).map((s) => s.key) : undefined;
  const applies: WelcomePreview['applies'] = openedBy ? 'openedBy'
    : runs ? 'runs'
    : !own?.template ? (deploymentApplies ? 'deployment' : 'builtIn')
      : !opening.usedTemplate ? 'emptyTemplate'
        : typed ? 'type' : 'default';
  return {
    content: opening.content, applies, deploymentCopy: deploymentApplies && !own?.template, ownFields: !!own?.orientation,
    ...(openedBy ? { openedBy } : {}),
    ...(runs && !openedBy ? { runs } : {}),
    opens: !!plan.opening,
    // THE INTAKE STARTS WHERE THE JOIN SAYS THE WELCOME and no workflow on another event owns the people it was opened for.
    intake: !plan.runs && !owner,
  };
}

const WelcomeEditorGuide: React.FC<{
  /** The draft's event workflows, the welcome among them. */
  workflows: Record<string, EventWorkflow> | null;
  /** The conversation type being edited; empty for every other room. */
  conversationType?: string;
  /** The classification, for naming the deployment's orientation parameter. */
  classification?: string;
  role?: string;
  /** The deployment's copy and the assistant's name, so the preview shows what the room is greeted with. */
  context?: WelcomePreviewContext;
}> = ({ workflows, conversationType, classification, role, context = {} }) => {
  const { t } = useTranslation();
  const [sample, setSample] = useState<Sample>('none');
  const conversation: WelcomeOrientation = sample === 'none' ? {} : sample === 'topic' ? { topic: t('admin.welcome.sampleTopic') }
    : sample === 'event' ? { eventSummary: t('admin.welcome.sampleEvent') }
      : { priorSubject: t('admin.welcome.sampleTopic'), priorMessage: t('admin.welcome.samplePriorMessage') };
  const preview = previewWelcome(workflows, conversationType, conversation, role || t('admin.welcome.sampleRole'), context);
  const type = conversationType || '';

  return (
    <div className="admin-welcome-guide" data-testid="welcome-guide">
      {/* WHAT A BLANK OPENING SAYS, for this assistant: the deployment's welcome where it applies (the router's
          precedence, as `previewWelcome` reads it), else the built-in opening. */}
      <p className="admin-field-hint" data-testid="welcome-built-in">
        {context.isPrimary !== false && context.deployment
          ? t('admin.welcome.blankUsesDeployment')
          : t('admin.welcome.builtIn')}
      </p>
      {context.unread && <p className="admin-field-hint" role="alert" data-testid="welcome-unread">{t('admin.welcome.unread')}</p>}

      <h5>{t('admin.welcome.previewTitle')}</h5>
      <label>
        <span className="admin-field-label">{t('admin.welcome.previewSample')}</span>
        <select className="select" value={sample} onChange={(e) => setSample(e.target.value as Sample)} data-testid="welcome-sample">
          <option value="none">{t('admin.welcome.sample.none')}</option>
          <option value="topic">{t('admin.welcome.sample.topic')}</option>
          <option value="event">{t('admin.welcome.sample.event')}</option>
          <option value="continued">{t('admin.welcome.sample.continued')}</option>
        </select>
      </label>
      <p className="admin-field-hint" data-testid="welcome-applies">
        {t(`admin.welcome.applies.${preview.applies === 'default' && type ? 'defaultForType' : preview.applies === 'runs' && preview.opens ? 'runsWithOpening' : preview.applies}`, { type, name: preview.openedBy, steps: (preview.runs ?? []).join(', ') })}
        {sourceNote(preview, context) && <> {t(sourceNote(preview, context)!, {
          param: `/agent-echelon/assistant/${classification || '<classification>'}/welcome-orientation`,
        })}</>}
      </p>
      {preview.applies !== 'openedBy' && (preview.applies !== 'runs' || preview.opens) && <pre className="admin-welcome-preview" data-testid="welcome-preview">{preview.content}</pre>}
      {preview.intake && <IntakeAfter intake={context.intake} />}
    </div>
  );
};

export default WelcomeEditorGuide;

/**
 * WHAT A WELCOME'S OPENING IS BUILT FROM BEYOND THE VERSION, for the editor's preview and the active page alike: the
 * deployment's copy and onboarding where they apply to this assistant (its classification's primary,
 * `deploymentCopyAppliesTo`), its name and role, and every workflow it runs. The catalog not read is said.
 */
export function welcomeContextFor(args: {
  version: { displayName?: string; eventWorkflows?: Record<string, EventWorkflow> | null; onboarding?: { greeting?: string; fields?: Array<{ prompt?: string }> }; variables?: Readonly<Record<string, VersionVariable>> } | null | undefined;
  catalog?: { welcomeOrientation?: WelcomeOrientation; primaryAssistant?: string; onboardingIntake?: { greeting?: string; questions: string[] }; classification?: string; variables?: PublishedVariables };
  assistant?: string;
  role?: string;
  /** The name the assistant was provisioned with, which the room shows when the version names none. */
  provisionedName?: string;
}): WelcomePreviewContext {
  const { version, catalog, assistant, role, provisionedName } = args;
  const shownName = version?.displayName?.trim() || provisionedName?.trim() || assistant;
  const isPrimary = !catalog?.primaryAssistant || !assistant || catalog.primaryAssistant === assistant;
  const ownQuestions = (version?.onboarding?.fields ?? []).map((f) => f.prompt ?? '').filter(Boolean);
  const intake: WelcomePreviewContext['intake'] = ownQuestions.length
    ? { ...(version?.onboarding?.greeting ? { greeting: version.onboarding.greeting } : {}), questions: ownQuestions, source: 'version' }
    : isPrimary && catalog?.onboardingIntake ? { ...catalog.onboardingIntake, source: 'deployment' } : undefined;
  return {
    ...(catalog?.welcomeOrientation ? { deployment: catalog.welcomeOrientation } : {}),
    isPrimary,
    ...(shownName ? { assistantName: shownName } : {}),
    ...(role ? { role } : {}),
    ...(catalog?.classification ? { classification: catalog.classification } : {}),
    ...(catalog?.variables ? { published: catalog.variables } : {}),
    // THE VERSION'S OWN VARIABLES, which the router resolves the opening through (`routerHeldVariables`).
    ...(version?.variables ? { variables: version.variables } : {}),
    allWorkflows: version?.eventWorkflows ?? null,
    ...(intake ? { intake } : {}),
    ...(catalog ? {} : { unread: true }),
  };
}

/** Where the shown text comes from beyond this welcome: the deployment's copy, under or in place of its own fields. */
function sourceNote(preview: WelcomePreview, context: WelcomePreviewContext): string | undefined {
  if (preview.applies === 'openedBy') return undefined;
  if (preview.deploymentCopy) return preview.ownFields ? 'admin.welcome.deploymentCopyLayered' : 'admin.welcome.deploymentCopy';
  if (preview.applies !== 'builtIn') return undefined;
  return context.isPrimary === false ? 'admin.welcome.deploymentCopyNotPrimary' : 'admin.welcome.deploymentCopyNone';
}

/** WHAT FOLLOWS THE OPENING for a person the assistant has not met, in a one-person conversation: its onboarding's question. */
const IntakeAfter: React.FC<{ intake?: WelcomePreviewContext['intake'] }> = ({ intake }) => {
  const { t } = useTranslation();
  if (!intake?.questions.length) return null;
  return (
    <div data-testid="welcome-intake">
      <p className="admin-field-hint">{t(`admin.welcome.intake.${intake.source}`)}</p>
      <pre className="admin-welcome-preview">{[intake.greeting, intake.questions[0]].filter(Boolean).join('\n')}</pre>
    </div>
  );
};

/**
 * WHAT A NEW CONVERSATION IS GREETED WITH, on the active version's page: the content an assistant presents always shows in
 * the console, so it is obvious to an editor they are in the right place. The same preview the editor shows, from the active version and the deployment's copy, for an ordinary
 * conversation, with where its text is set.
 */
export const GreetedWith: React.FC<{
  workflows: Record<string, EventWorkflow> | null | undefined;
  classification?: string;
  role?: string;
  context?: WelcomePreviewContext;
}> = ({ workflows, classification, role, context = {} }) => {
  const { t } = useTranslation();
  const preview = previewWelcome(workflows, '', {}, role, context);
  const source = preview.applies === 'deployment' ? 'deployment'
    : preview.applies === 'builtIn' || preview.applies === 'emptyTemplate' ? 'builtIn' : 'own';
  return (
    <div className="admin-welcome-guide" data-testid="welcome-greeted-with">
      <h5>{t('admin.welcome.greetedWith.title')}</h5>
      {preview.runs && (
        <p className="admin-field-hint" data-testid="welcome-greeted-with-runs">
          {t(preview.opens ? 'admin.welcome.greetedWith.runsWithOpening' : 'admin.welcome.greetedWith.runs', { steps: preview.runs.join(', ') })}
        </p>
      )}
      {preview.runs && preview.opens && <pre className="admin-welcome-preview" data-testid="welcome-greeted-with-text">{preview.content}</pre>}
      {!preview.runs && (
        <>
          <pre className="admin-welcome-preview" data-testid="welcome-greeted-with-text">{preview.content}</pre>
          <p className="admin-field-hint" data-testid="welcome-greeted-with-source">
            {t(`admin.welcome.greetedWith.source.${source}${source === 'deployment' && preview.ownFields ? 'Layered' : ''}`, {
              param: `/agent-echelon/assistant/${classification || '<classification>'}/welcome-orientation`,
            })}
          </p>
        </>
      )}
      {context.unread && <p className="admin-field-hint" role="alert" data-testid="welcome-greeted-with-unread">{t('admin.welcome.unread')}</p>}
      {preview.intake && <IntakeAfter intake={context.intake} />}
    </div>
  );
};
