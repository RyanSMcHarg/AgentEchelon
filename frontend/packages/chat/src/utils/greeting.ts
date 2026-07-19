/** Tier-specific welcome copy shown as the empty-state of a new
 *  conversation. This is rendered by the frontend only — it is NOT sent
 *  as a Chime message. Earlier versions of AE posted this string into
 *  the channel via the user's identity on every channel create, which
 *  (a) showed up as a message authored by the user, (b) triggered an
 *  unwanted bot response, and (c) re-appeared at the top of every
 *  conversation instead of just the empty one. Keeping it client-side
 *  fixes all three. */
import type { UserTier } from '@ae/shared';

const BASIC = `Welcome to Agent Echelon. Try asking things like:

• "Summarize the key differences between REST and GraphQL"
• "Write a Python function to validate email addresses"
• "What are the GDPR requirements for data retention?"
• "Explain how Kubernetes pods communicate"

This conversation is suited for quick Q&A, lookups, and simple tasks.`;

const STANDARD = `Welcome to Agent Echelon. Try asking things like:

• "Review this SQL query for performance issues and suggest improvements"
• "Walk me through setting up a CI/CD pipeline for a Node.js app"
• "Compare three approaches to caching in a microservices architecture"
• "Generate a TypeScript API client from this OpenAPI spec"
• "Help me troubleshoot why our Lambda cold starts exceed 3 seconds"

This conversation supports multi-step workflows, code generation, and detailed analysis.`;

const PREMIUM = `Welcome to Agent Echelon. Try asking things like:

• "Design a data pipeline architecture for processing 10M events/day with exactly-once delivery"
• "Audit this IAM policy for privilege escalation risks and suggest least-privilege alternatives"
• "Generate a comprehensive cost-benefit report comparing Aurora vs DynamoDB for our workload"
• "Review our system design and identify single points of failure"
• "Help me plan a zero-downtime migration from monolith to microservices"

This is a premium conversation with the most capable model. It supports report generation with downloadable documents, advanced multi-step workflows, and deep analysis.`;

export function getModelGreeting(tier: UserTier): string {
  if (tier === 'basic') return BASIC;
  if (tier === 'standard') return STANDARD;
  return PREMIUM;
}
