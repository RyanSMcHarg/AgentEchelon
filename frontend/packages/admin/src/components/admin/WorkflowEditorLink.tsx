/**
 * A WORKFLOW NAMED IN ANALYTICS, LINKED TO ITS ASSISTANT'S WORKFLOW EDITOR.
 *
 * The link is a real URL (`workflowEditorSearch`), so it opens in a new tab or is sent to someone; a plain click opens the
 * editor in place through the console's own navigation (`WorkflowEditorNavigation`), with no reload. The assistant is the
 * row's own where the row carries one, else the one the view is narrowed to, else the assistant a team member's console is
 * scoped to; with none of them, or for a person who cannot open the Assistants tab, the name reads as plain text.
 */
import React, { createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { useCan } from '../../capabilities';
import { teamAssistant } from '../../services/teamScope';
import { workflowEditorSearch, type WorkflowEditorLink as Link } from './assistantLinks';

/** Opens the editor on one workflow without a reload; the console's dashboard provides it. */
export const WorkflowEditorNavigation = createContext<((link: Link) => void) | null>(null);

const WorkflowEditorLink: React.FC<{
  /** The row's assistant, or the assistant the view is narrowed to. */
  assistant?: string | null;
  /** An event workflow's name, or an intent's key. */
  workflow?: string | null;
  /** A task machine's key. */
  task?: string | null;
  /** With `workflow` as an intent's key: the step of its task machine the editor opens on. */
  step?: string | null;
  testId?: string;
  /** Render nothing, rather than the plain text, where no link can be made: for words that only make sense as a link. */
  linkOnly?: boolean;
  /** A space before the link, written only when the link is: for a link set beside other words. */
  spaced?: boolean;
  children: React.ReactNode;
}> = ({ assistant, workflow, task, step, testId, linkOnly, spaced, children }) => {
  const { t } = useTranslation();
  const can = useCan();
  const open = useContext(WorkflowEditorNavigation);
  const owner = assistant || teamAssistant();
  const name = task || workflow;
  if (!owner || !name || !can('view-profiles')) return linkOnly ? null : <>{children}</>;
  const link: Link = { assistant: owner, ...(task ? { task } : { workflow, ...(step ? { step } : {}) }) };
  const label = !task && step ? t('admin.workflowLink.openStep', { step, name, assistant: owner }) : t('admin.workflowLink.open', { name, assistant: owner });
  return (
    <>{spaced && ' '}<a href={workflowEditorSearch(link)} data-testid={testId} title={label} aria-label={label}
      onClick={(e) => {
        if (!open || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(link);
      }}>{children}</a></>
  );
};

export default WorkflowEditorLink;
