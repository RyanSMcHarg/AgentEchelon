/**
 * WHAT THE CONSOLE DOES WITH EVERY FIELD OF A PROFILE VERSION, declared once (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * The owner's rule for an assistant's page: every element is either editable at runtime (a control and its
 * help), editable only as JSON where that was agreed (the console says exactly where and how), or not
 * editable (the console says what drives it and how it is changed). A body field nobody decided about is the
 * failure this table exists to prevent: it rides every version, changes behavior, and the page says nothing.
 *
 * `Record<keyof ProfileDefinitionBody, ...>` makes a new body field without an entry a compile error, and
 * `profile-field-decisions.test.ts` checks the same against the interface's source, so CI refuses it either
 * way. The table is served with the profile listing and the console renders from it, so the two cannot
 * disagree about which fields have a control.
 *
 * The prose for each field (its help, its edit path's explanation) is the console's locale, keyed by field.
 * This table carries only facts: the kind, the literal command, the guide section.
 */
import type { ProfileDefinitionBody } from './active-profile.js';

/** `control`: a console control saves it through the draft patch. */
export interface ControlDecision { kind: 'control' }

/** `json`: edited as JSON through a draft patch or a manifest import, until the owner reviews its shape. */
export interface JsonDecision {
  kind: 'json';
  /** The literal command an operator runs (a shell line, never prose). */
  command: string;
  /** The guide section that documents the field. */
  guide: FieldGuide;
}

/** `readonly`: a version carries it, but what sets it is elsewhere (an experiment, the platform). */
export interface ReadonlyDecision {
  kind: 'readonly';
  /** What sets it, as a short key the console's locale explains. */
  drivenBy: 'experiments' | 'model-bundle' | 'migration';
  guide: FieldGuide;
}

export type FieldDecision = ControlDecision | JsonDecision | ReadonlyDecision;

/** Guide sections the console links to, by key (the console maps each to a documentation anchor). */
export type FieldGuide = 'personaOrPack' | 'globalWorkflows' | 'onboarding' | 'boundary' | 'experiments' | 'models' | 'messages' | 'variables' | 'welcome' | 'goldenSet';

const PATCH = 'npm run assistant -- draft <assistant> --patch <file.json>';

export const PROFILE_FIELD_DECISIONS: Record<keyof ProfileDefinitionBody, FieldDecision> = {
  // The legacy spelling of `models.default`; the base-model select writes both (`editDraft` keeps them equal).
  modelKey: { kind: 'readonly', drivenBy: 'model-bundle', guide: 'models' },
  models: { kind: 'control' },
  tools: { kind: 'control' },
  guardrailId: { kind: 'control' },
  displayName: { kind: 'control' },
  persona: { kind: 'control' },
  contextSources: { kind: 'control' },
  // RETIRED (W1): the welcome is the version's assistant-joined workflow, edited in the Event workflows section. A stored
  // version may still carry one; `npm run migrate-legacy-welcome` carries it into its workflows, and a draft refuses it.
  welcome: { kind: 'readonly', drivenBy: 'migration', guide: 'welcome' },
  // RETIRED (ADR-062): what an assistant says is its message templates. A stored version may still carry lines here;
  // `npm run migrate-legacy-copy` makes them the assistant's own templates, and a draft refuses a line.
  copy: { kind: 'readonly', drivenBy: 'migration', guide: 'messages' },
  // Which template a message is said from (one of the assistant's own, `@classification` or `@shipped`), as a name or an
  // ordered list of { template, when }: picked per message in the console's Message templates section, with a condition
  // builder (ADR-060 slice 1e), where the assistant's own templates are edited too.
  messages: { kind: 'control' },
  // Edited in the draft's own Event workflows section, the welcome among them: the assistant-joined workflow the room's
  // conversation type selects (W1, ADR-061 decision 1).
  eventWorkflows: { kind: 'control' },
  // The values a version names (ADR-060 decision 1). Named as JSON with a draft patch; the console lists them in its
  // variable picker beside the sources the classification publishes, which every condition and insertion reads.
  variables: { kind: 'json', command: PATCH, guide: 'variables' },
  // Owner decision pending on the JSON shape: edited as JSON for now.
  intentPack: { kind: 'json', command: PATCH, guide: 'personaOrPack' },
  workflows: { kind: 'json', command: PATCH, guide: 'globalWorkflows' },
  // When a workflow's confirmed step is put to the person (ADR-064 decision G), per workflow, named as JSON with a draft
  // patch; the console shows it beside the workflow selection.
  confirmBrief: { kind: 'json', command: PATCH, guide: 'globalWorkflows' },
  // A version may not define a machine; they are global workflows (the platform's and the classification pack's).
  machines: { kind: 'json', command: 'npm run deploy:stack -- Assistants-<classification>', guide: 'globalWorkflows' },
  onboarding: { kind: 'json', command: PATCH, guide: 'onboarding' },
  boundary: { kind: 'json', command: PATCH, guide: 'boundary' },
  // The fewest regression entries per intent a draft of this assistant is measured on (ADR-065 decision 6), named as
  // JSON with a draft patch; the gate reads it from the active version.
  goldenSet: { kind: 'json', command: PATCH, guide: 'goldenSet' },
  // An experiment variant's addendum lands here when a duel side is derived; promotion carries it.
  systemPromptAddendum: { kind: 'readonly', drivenBy: 'experiments', guide: 'experiments' },
};

/** The table as the listing serves it. */
export function fieldDecisions(): Record<string, FieldDecision> {
  return PROFILE_FIELD_DECISIONS;
}
