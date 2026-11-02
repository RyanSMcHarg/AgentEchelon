/**
 * What each Stratum DEMO assistant does NOT reach, in one line a person reads.
 *
 * AUTHORED BECAUSE ABSENCE IS NOT A PHRASE. An assistant's capabilities are assembled from the intents
 * it advertises (`lib/assistant-capabilities.ts`); what it cannot do is not in the pack at all, because
 * a pack says nothing about the intents it does not declare. So this half stays written by hand, once,
 * next to everything else about the assistant.
 *
 * IT IS THE MOST USEFUL SENTENCE IN AN INTRODUCTION, which is why it is not an afterthought. A person
 * deciding which assistant to ask is helped more by "I cannot see customer accounts" than by another
 * item in a capability list, and without it the same impossible question gets asked repeatedly.
 *
 * ABOUT REACH, NOT QUALITY. Each line names data this assistant cannot get to. None of them apologizes
 * for how well it does what it does; a disclaimer in an introduction is noise, and a person cannot act
 * on it.
 */

/** Basic answers external conversations from public material only. */
export const BASIC_BOUNDARY =
  'I answer from public product documentation. I cannot see customer accounts, internal figures or '
  + 'anything behind the company login.';

/** Standard is the internal assistant: internal sources, but nothing commercial. */
export const STANDARD_BOUNDARY =
  'I can reach the employee directory and internal processes. Financial figures, named customer '
  + 'accounts and competitive material are outside what I can see.';

/** Premium reaches the widest set in the deployment, so its boundary is about where that still stops. */
export const PREMIUM_BOUNDARY =
  'I can reach financial metrics, named customer accounts and competitive intelligence as well as '
  + 'internal sources. I cannot act on any of it: I report, I do not change records.';

/**
 * The `ops` role's assistant on `premium`. About WRITES rather than about data, because its reach into
 * Stratum's material is its classification's and the thing that distinguishes it is operational.
 *
 * ITS BOUNDARY GRANTS READS AND NO WRITES, and that is asserted rather than described: no `PutDashboard`,
 * no `DeleteLogGroup`, no alarm mutation, checked against the deployed document by
 * `e2e/an-assistant-boundary-refuses-cloudwatch.spec.ts`. So this line is the person-facing form of an
 * IAM fact, not a promise about restraint.
 */
export const OPS_BOUNDARY =
  'I read this deployment\'s metrics and alarm state. I cannot change any of it - no alarm, no '
  + 'dashboard, no configuration - so acting on what I find stays a person\'s decision.';
