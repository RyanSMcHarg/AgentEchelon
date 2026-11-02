/**
 * Stratum DEMO onboarding intakes, per classification.
 *
 * WHY THESE DIFFER, which is the whole point of them riding the versioned profile. Onboarding is the
 * assistant's first impression, and one deployment-wide intake made every assistant introduce itself
 * identically and then behave completely differently - the least helpful order to do those two things
 * in. What an assistant should ask a person it has not met follows from what that assistant can DO for
 * them, and that is a per-profile fact.
 *
 * Read with `demo/intent-packs.ts`: the same gradient runs through both. `report_generation` is the
 * same intent at every classification and a different job, because what a report may be built from is
 * what the classification can reach; the opening question is different for exactly the same reason.
 *
 * ASKING IS THE LAST RESORT, NOT THE GATE (owner rule, 2026-09-03). Every field here declares what
 * already asserts it, so the intake asks only for what this turn genuinely cannot resolve. In the
 * shipped demo the persona names the company and the classification IS the role claim, so most of
 * these fields never fire - which is correct, and is why `assertedBy` is set on them rather than left
 * off to make the demo look busier than it should be.
 *
 * Same split as `demo/personas.ts` and `demo/intent-packs.ts`: demo CONTENT lives under `demo/`, and
 * the seeder stays the mechanism. `test/demo-seed-budget.test.ts` weighs these before any deploy.
 */
import type { IntakeConfig } from '../lambda/src/lib/onboarding-intake.js';

/**
 * BASIC - a product assistant answering from public documentation.
 *
 * It has no idea who the person is and does not need to: nothing it can reach is scoped to an
 * individual. So it asks the one thing that changes its answer, which product they are on. What it
 * COVERS is not restated here: that is assembled from its advertised intents and its boundary line.
 */
export const BASIC_ONBOARDING: IntakeConfig = {
  // NO CAPABILITY PROSE HERE. What this assistant does is assembled from its advertised intents and
  // its boundary line (lib/assistant-capabilities.ts); restating it would put the same fact in two
  // hand-maintained places, which is what made the greeting drift from the pack.
  greeting: 'Hello.',
  fields: [
    {
      key: 'product',
      // The product line as the basic context publishes it (context/basic/company-public.json) and the
      // demo company spec names it. This listed a product that does not exist, StratumInsight.
      prompt: 'Which Stratum product are you asking about? (StratumFlow, StratumConnect, StratumAnalytics, or "not sure")',
      required: false,
    },
  ],
  completion: 'Thanks{name}. Ask me anything about the product and I will answer from the documentation.',
};

/**
 * STANDARD - the internal assistant, reaching the directory and internal processes.
 *
 * It CAN scope an answer to a person: which team they are on changes which runbook and which
 * escalation path is theirs. `company` and `role` are deliberately NOT asked - the persona names the
 * company and the classification is the role claim, which is the exact case the `assertedBy` rule was
 * written for after this assistant asked an employee which company they worked for.
 */
export const STANDARD_ONBOARDING: IntakeConfig = {
  greeting: 'Hi. I am the Stratum internal assistant.',
  fields: [
    {
      key: 'team',
      prompt: 'Which team are you on? It helps me point you at the right runbook and escalation path.',
      required: false,
      assertedBy: ['profile'],
    },
    {
      key: 'company',
      prompt: 'Which company are you with?',
      required: false,
      // Asserted by the persona, which opens by naming Stratum. Kept declared so the fallback path
      // stays exercised on a deployment whose persona does NOT name a company.
      assertedBy: ['persona'],
    },
  ],
  completion: 'Thanks{name}. Ask me about a process, a runbook or who owns what.',
};

/**
 * PREMIUM - the classification that reaches financials, named accounts and competitive material.
 *
 * The widest reach in the deployment. What it can see is said by its advertised intents and its
 * boundary line rather than by this greeting, so the two cannot disagree. It asks what a report should
 * default to covering, because here a report is genuinely built from more.
 *
 * THE GREETING NAMES NO AUDIENCE. "Leadership" is who this demo company points at it, not what the
 * classification is: a classification is the set of grants it declares (ADR-046), and calling the
 * premium assistant the leadership assistant read as though the two were the same axis.
 */
export const PREMIUM_ONBOARDING: IntakeConfig = {
  greeting: 'Welcome.',
  // A REPLY PREFERENCE, NOT A FACT (owner, 2026-10-14). Answer style shapes every reply in every
  // conversation (lib/config/reply-preferences.ts), so asking once is worth it; a reporting default
  // stored as a fact shaped nothing after the conversation it was asked in. The offer never blocks: a
  // message that is not itself one of these answers goes to the assistant and the offer stays open, and
  // onboarding completes once a value, or "no preference", is chosen.
  fields: [
    {
      key: 'answerStyle',
      preference: 'answerStyle',
      prompt: 'How do you like answers: just the figure, the figure with what it means, or no preference?',
      required: false,
    },
  ],
  // Not shown for a preference-only offer: the assistant confirms the choice in its own voice.
  completion:
    'Thanks{name}. Ask me for a figure, an account, or a report and I will say which sources it draws on.',
};
