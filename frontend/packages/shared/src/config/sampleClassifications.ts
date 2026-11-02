/**
 * A TEST FIXTURE: the shipped catalog's classifications as the backend publishes them
 * (`clientClassifications(DEFAULT_PROFILES_CONFIG)`, `backend/lib/config/profiles.ts`), for a test that
 * renders the sample deployment. No component reads this; the running app reads `GET /classifications`.
 *
 * The member sets nest (basic, standard, premium) only because the sample is configured that way. A
 * classification reaches what its `grants` names (ADR-046), sets need not nest, and `customer` and
 * `guest` here are disjoint from every member set: nothing a member holds reaches them.
 */
import type { ClientClassification } from './classifications';

export const SAMPLE_CLASSIFICATIONS: ClientClassification[] = [
  { value: 'basic', displayName: 'Basic', audience: 'members', badgeToken: 'cls-1', grants: ['basic'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'standard', displayName: 'Standard', audience: 'members', badgeToken: 'cls-2', grants: ['basic', 'standard'], conversational: true, models: { selected: ['haiku', 'sonnet', 'titan', 'gpt_oss_20b', 'deepseek_v3', 'deepseek_r1'], default: 'sonnet' } },
  { value: 'premium', displayName: 'Premium', audience: 'members', badgeToken: 'cls-3', grants: ['basic', 'standard', 'premium'], conversational: true, models: { selected: ['haiku', 'sonnet', 'opus', 'titan', 'gpt_oss_20b', 'gpt_oss_120b', 'deepseek_v3'], default: 'opus' } },
  { value: 'admin', displayName: 'Admin', audience: 'members', badgeToken: 'cls-4', grants: ['admin'], conversational: false, adminPlane: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'guest', displayName: 'Guest', audience: 'outside', badgeToken: 'cls-5', grants: ['guest'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'customer', displayName: 'Customer', audience: 'outside', badgeToken: 'cls-6', grants: ['customer'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
];
