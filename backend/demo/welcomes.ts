/**
 * Per-ASSISTANT welcome workflows for the Stratum demo, seeded onto each profile's version (W1).
 *
 * THE WELCOME IS AN INTENT, SO IT BELONGS TO THE ASSISTANT. It is the assistant's `assistant-joined` workflow, which
 * `WelcomeIntent` starts, and an opening step with no field of its own falls back to
 * `{SSM_ROOT}/assistant/{classification}/welcome-orientation`, which is ONE config for every assistant the
 * classification holds. While each classification held one assistant that was invisible. The moment `premium` held
 * two, both opened with the same words.
 *
 * AN EARLIER ATTEMPT PUT THIS ON THE CONVERSATION TYPE, keyed by role, and that was wrong twice: it moved an assistant's
 * words onto the room, and it made adding an assistant or a type an edit to compiled deployment config instead of to the
 * runtime artifact the owning team controls. Here the welcome travels with the assistant, so whoever owns that assistant
 * rewords it, validates it, activates it and rolls it back like any other behavior, with no deploy.
 *
 * ── WHAT VARIES, AND WHAT DOES NOT ──────────────────────────────────────────────────────────────
 *
 * A welcome workflow's `types` is how ONE assistant opens differently in different kinds of room: the room's type
 * selects the workflow that names it, else the one that names none. The role needs no key: an assistant acts in exactly
 * one classification (ADR-042) and a difference between two jobs is a second role with a second assistant (ADR-048), so
 * the profile already fixes the role. A template can still name it with `{{role}}`.
 *
 * An opening step carries the deployment fields only (`companyName`, `companyBlurb`, `accessBlurb`, `examples`,
 * `platformNote`) and its own `text`. The per-conversation fields are carried on the channel and a version may not set
 * them.
 */
import type { EventWorkflow } from '../lambda/src/lib/event-workflow.js';
import type { WelcomeOpeningStep } from '../lambda/src/lib/welcome-orientation.js';

/** A welcome that says one opening, in the rooms `types` names (none: every room no other welcome names). */
function opens(opening: WelcomeOpeningStep, types?: string[]): EventWorkflow {
  return {
    on: 'assistant-joined',
    ...(types ? { types } : {}),
    initial: 'opening',
    states: {
      opening: { opening, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  };
}

/**
 * The `ops` role's assistant on `premium`.
 *
 * SAME COMPANY, DIFFERENT ACCESS, for an ordinary room: `companyName` and `companyBlurb` match the premium copy because
 * the room is the same company's, and what distinguishes this assistant is what it reaches, so the difference is carried
 * by `accessBlurb` and `examples`.
 *
 * AND A DIFFERENT OPENING ENTIRELY IN AN ALERT ROOM. In an `ops` conversation the clause assembly says nothing useful:
 * the room is spawned, so the assembly suppresses the introduction (correctly - nobody arrived cold) and prints only the
 * continuity line, which is the ROOM's and therefore identical for every assistant in it. The text below replaces it with
 * what this assistant is actually for, and names the event. `{{eventSummary}}` sits on its own line because a line whose
 * field the room does not carry is DROPPED: a room opened with no summary reads as if that sentence was never written.
 */
export const OPS_WELCOME: Record<string, EventWorkflow> = {
  welcome: opens({
    companyName: 'Stratum Technologies',
    companyBlurb: 'an enterprise SaaS company (workflow automation, ~280 people, based in Austin)',
    accessBlurb:
      'You have operations access in this conversation: I read this deployment\'s own telemetry - '
      + 'CloudWatch metrics and alarm state - which the Stratum business assistants cannot '
      + 'reach. I read it only; I change nothing.',
    examples: [
      'What is the error rate across the deployment right now?',
      'Which functions are slowest, and since when?',
      'Which alarms are in alarm, and what do they cover?',
    ],
    platformNote:
      'I also know the AgentEchelon platform that powers this demo - ask me "how does AgentEchelon work?" '
      + 'or "how do I customize it?"',
  }),
  'welcome-ops': opens({
    text:
      'This conversation is open for an operations issue.\n'
      + '{{eventSummary}}\n'
      + 'I can read this deployment\'s metrics and alarm state - ask me what is happening and I '
      + 'will start there.',
  }, ['ops']),
};

/**
 * The premium PRIMARY, in an alert room and the operations team's standing room only.
 *
 * NO WELCOME FOR EVERY OTHER ROOM, AND THAT IS THE DESIGN RATHER THAN AN OMISSION. This assistant's ordinary opening is
 * the platform's `welcome`, which says the premium classification's configured orientation, written for it and seeded
 * as that parameter. Giving it a copy here too would be two sources for one sentence with no way to tell which one a
 * deployment reads.
 *
 * ONE LINE IN AN ALERT ROOM, AND IT DOES NOT RE-TELL THE EVENT. The owner's rule: the role the room was opened FOR reads
 * the context and gets the person started; the primary stays quiet or says no more than that it is checking in. A
 * primary that also named the alert would reintroduce the duplicate in a longer form.
 */
export const ADVISOR_WELCOME: Record<string, EventWorkflow> = {
  'welcome-ops': opens({ text: 'I am here too, and I am checking in on this one.' }, ['ops']),
  // THE OPERATIONS TEAM'S STANDING ROOM. The platform opens it with no event behind it, so the classification's
  // orientation (a company introduction and leadership examples) answers a question nobody in this room is asking. It
  // says what the room is, who is in it and why that changes on its own, and where the operations assistant comes in.
  // `{{topic}}` is the label the room was opened with; its line drops if the room carries none.
  'welcome-ops-team': opens({
    text:
      'This is the operations team\'s standing room.\n'
      + 'It is for {{topic}}.\n'
      + 'Everyone in the ops group is here, and people join or leave as the group changes.\n'
      + 'Ask me anything here. When an alert opens an incident, a separate room opens for it with the '
      + 'Ops assistant, which reads this deployment\'s metrics and alarm state.',
  }, ['ops-team']),
};
