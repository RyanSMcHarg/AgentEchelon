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
 * ASKING IS THE LAST RESORT, NOT THE GATE. Every field here declares what
 * already asserts it, so the intake asks only for what this turn genuinely cannot resolve. In the
 * shipped demo the persona names the company and the classification IS the role claim, so most of
 * these fields never fire - which is correct, and is why `assertedBy` is set on them rather than left
 * off to make the demo look busier than it should be.
 *
 * Same split as `demo/personas.ts` and `demo/intent-packs.ts`: demo CONTENT lives under `demo/`, and
 * the seeder stays the mechanism. `test/demo-seed-budget.test.ts` weighs these before any deploy.
 */
import type { IntakeConfig } from '../../backend/lambda/src/lib/onboarding-intake.js';
/**
 * BASIC - a product assistant answering from public documentation.
 *
 * It has no idea who the person is and does not need to: nothing it can reach is scoped to an
 * individual. So it asks the one thing that changes its answer, which product they are on. What it
 * COVERS is not restated here: that is assembled from its advertised intents and its boundary line.
 */
export declare const BASIC_ONBOARDING: IntakeConfig;
/**
 * STANDARD - the internal assistant, reaching the directory and internal processes.
 *
 * It CAN scope an answer to a person: which team they are on changes which runbook and which
 * escalation path is theirs. `company` and `role` are deliberately NOT asked - the persona names the
 * company and the classification is the role claim, which is the exact case the `assertedBy` rule was
 * written for after this assistant asked an employee which company they worked for.
 */
export declare const STANDARD_ONBOARDING: IntakeConfig;
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
export declare const PREMIUM_ONBOARDING: IntakeConfig;
