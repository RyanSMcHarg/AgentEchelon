/**
 * ONE EVENT WORKFLOW, READ ON THE ASSISTANT'S PAGE (SPEC-ADMIN-CONSOLE "Assistants", Workflows).
 *
 * The event that starts it in words, the rooms it runs in, its steps as one line in the order a run reaches them, and,
 * for a welcome, the opening a person reads, composed by the router's own composer (`eventWorkflowPreview.ts`). It is
 * read-only: the workflow is edited on the draft's builder, which the page's Edit in a draft action opens.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { previewOpening, workflowSteps, type StepSummary } from './eventWorkflowPreview';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** The event that starts a workflow, as a person says it. */
const eventLabel = (t: T, event: string): string => t(`admin.eventWorkflows.event.${event}`);

/** One step in the sequence: its kind, and the role, template, prompt or machine it names. */
function stepText(t: T, s: StepSummary): string {
  const kind = t(`admin.workflowEditor.kind_${s.kind}`);
  if (s.disposition === 'failure') return t('admin.eventWorkflows.stepFailure', { kind });
  if (s.as) return t('admin.eventWorkflows.stepAs', { kind, role: s.as, names: s.names ?? '' });
  return s.names ? t('admin.eventWorkflows.stepNamed', { kind, names: s.names }) : kind;
}

/**
 * THE OPENING AS THE PERSON READS IT: paragraphs, the examples as a list, a quoted message as a quote. The text is the
 * composer's; this only lays out its lines.
 */
export const OpeningText: React.FC<{ content: string; testId?: string }> = ({ content, testId }) => {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{para.join(' ')}</p>);
    para = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((item, i) => <li key={i}>{item}</li>)}</ul>);
    list = [];
  };
  for (const line of content.split('\n')) {
    if (line.startsWith('- ')) { flushPara(); list.push(line.slice(2)); continue; }
    flushList();
    if (!line.trim()) { flushPara(); continue; }
    if (line.startsWith('> ')) { flushPara(); blocks.push(<blockquote key={blocks.length}>{line.slice(2)}</blockquote>); continue; }
    para.push(line);
  }
  flushPara();
  flushList();
  return <div className="admin-opening-preview" data-testid={testId}>{blocks}</div>;
};

/** A welcome's opening, previewed, with where its words come from. */
export const WelcomePreview: React.FC<{ name: string; workflow: EventWorkflow; role?: string }> = ({ name, workflow, role }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const preview = previewOpening(workflow, (field) => t('admin.eventWorkflows.sample', {
    name: t(`admin.eventWorkflows.sampleName.${field}`, { defaultValue: field }),
  }), role);
  return (
    <div className="admin-welcome-says" data-testid={`workflow-says-${name}`}>
      <span className="admin-field-label">{t('admin.eventWorkflows.says')}</span>
      <span className="admin-field-hint" data-testid={`workflow-says-source-${name}`}>{t(`admin.eventWorkflows.source.${preview.source}`)}</span>
      {preview.content && <OpeningText content={preview.content} testId={`workflow-opening-${name}`} />}
      {preview.prompt && <span className="admin-field-hint">{t('admin.eventWorkflows.thenPrompt', { prompt: preview.prompt })}</span>}
    </div>
  );
};

/** What an event workflow is: the event that starts it, the rooms it runs in, its steps, and a welcome's opening. */
const EventWorkflowSummary: React.FC<{ name: string; workflow: EventWorkflow; role?: string }> = ({ name, workflow, role }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const welcome = workflow.on === 'assistant-joined';
  const rooms = workflow.types?.length
    ? workflow.types.join(', ')
    : t(welcome ? 'admin.eventWorkflows.roomsOther' : 'admin.eventWorkflows.roomsEvery');
  const steps = workflowSteps(workflow);
  return (
    <>
      <span data-testid={`workflow-starts-${name}`}>{t('admin.eventWorkflows.starts', { event: eventLabel(t, workflow.on), rooms })}</span>
      <span className="admin-workflow-steps" data-testid={`workflow-steps-${name}`}>
        <span className="admin-field-label">{t('admin.eventWorkflows.steps')}</span>{' '}
        {steps.map((s) => stepText(t, s)).join(t('admin.eventWorkflows.stepSeparator'))}
      </span>
      {welcome && <WelcomePreview name={name} workflow={workflow} role={role} />}
    </>
  );
};

export default EventWorkflowSummary;
