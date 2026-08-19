/**
 * The per-classification ROUTER table, in one place.
 *
 * The router (`router-agent-handler`) is the same Lambda Lex fulfills into, the one the channel flow's
 * `@all` bypass hands to, and the one task-answer repair re-dispatches through. Each of those used to
 * carry its own copy of this three-way switch. Two routing tables that disagreed about a classification
 * would answer a turn on one classification's router while another component believed it went
 * elsewhere - so the table lives here and every caller imports it.
 *
 * The fail-safe rules are the point, and they are asymmetric on purpose:
 *
 *  - `basic` NEVER falls back UP. A downgrade to standard is the cross-classification context leak
 *    that routing exists to prevent, so an unset `BASIC_ROUTER_ARN` yields undefined and the caller
 *    declines the turn rather than answering it on a wider-context router.
 *  - `premium` MAY fall back DOWN to standard, which narrows context and cannot leak.
 *
 * The environment is read per call rather than captured at module load: this module is imported
 * transitively by handlers whose tests set `ROUTER_ARN` and friends before importing the handler, and
 * a load-order-sensitive capture turns that ordering into a silent source of wrong ARNs.
 */
export function routerArnForClassification(classification: string): string | undefined {
  const routerArn = process.env.ROUTER_ARN;
  switch (classification) {
    case 'premium':
      return process.env.PREMIUM_ROUTER_ARN || routerArn;
    case 'basic':
      return process.env.BASIC_ROUTER_ARN;
    default:
      return routerArn;
  }
}
