/**
 * A WELCOME WORKFLOW THE CONSOLE KEEPS WHILE THE WELCOME SAYS A TEMPLATE OR A PROMPT (ADR-067 stage 1, G40).
 *
 * The welcome's Edit switches between a template, a template then a prompt, and a workflow. A switch from Workflow
 * back to one of the other two would otherwise throw the workflow's other steps away, so they are kept here, on the
 * draft, outside `eventWorkflows`: no handler that runs a workflow reads this field, validation of what the version
 * does never sees it, and it is not hashed into `configId`. A kept welcome is therefore never the one that runs, and
 * switching back to Workflow restores it.
 *
 * It rides the version as an offloaded body beside the canvas layout (`profile-bodies.ts`, `keptWelcomeKey`), never
 * inline in the SSM definition: kept through every edit, by activation and into the next draft, cleared by `null`.
 */
import { versionEventWorkflowsErrors, type EventWorkflow } from './event-workflow.js';

/** The name the kept workflow is checked under; a workflow name, and one no version declares in `eventWorkflows`. */
const CHECKED_AS = 'kept-welcome';

/** Why a kept welcome is refused as written, or nothing: it must be a welcome (`on: 'assistant-joined'`) of a valid shape. */
export function keptWelcomeErrors(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['keptWelcomeWorkflow is one event workflow'];
  if ((raw as Partial<EventWorkflow>).on !== 'assistant-joined') {
    return ["keptWelcomeWorkflow is a welcome, so it starts on 'assistant-joined'"];
  }
  return versionEventWorkflowsErrors({ [CHECKED_AS]: raw })
    .map((e) => e.replace(`eventWorkflows.${CHECKED_AS}`, 'keptWelcomeWorkflow'));
}
