#!/usr/bin/env node
/**
 * Validate that a CloudTrail trail is LOGGING management events for this account and region.
 *
 * The platform depends on it twice: CloudTrail is the control-plane audit layer
 * (SPEC-ACCESS-AND-CONTROLS-AUDITING), and it is how a Cognito group change reaches EventBridge, which
 * keeps group-sourced conversations and the admin conversations in sync without polling. Without a trail
 * an account keeps only the 90-day event history, which nothing can subscribe to - and both claims are
 * then quietly false. The foundations stack creates one unless `-c platformTrail=false`; an organization
 * trail satisfies this check too.
 *
 * Uses the AWS CLI so the check needs no SDK client of its own.
 */
import { execFileSync } from 'node:child_process';

const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
const aws = (args) => JSON.parse(execFileSync('aws', [...args, '--output', 'json'], { env, encoding: 'utf8' }));

const trails = aws(['cloudtrail', 'describe-trails', '--include-shadow-trails']).trailList || [];
const logging = [];
for (const t of trails) {
  const status = aws(['cloudtrail', 'get-trail-status', '--name', t.TrailARN]);
  if (!status.IsLogging) continue;
  const sel = aws(['cloudtrail', 'get-event-selectors', '--trail-name', t.TrailARN]);
  const basic = (sel.EventSelectors || []).some((s) => s.IncludeManagementEvents !== false);
  const advanced = (sel.AdvancedEventSelectors || []).some((a) =>
    (a.FieldSelectors || []).some((f) => f.Field === 'eventCategory' && (f.Equals || []).includes('Management')));
  if (basic || advanced) logging.push(`${t.Name}${t.IsOrganizationTrail ? ' (organization)' : ''}`);
}

if (!logging.length) {
  console.error('[audit-trail] FAIL: no CloudTrail trail is logging management events here.');
  console.error('  Group-sourced conversations and the admin conversations will only sync on the daily backstop,');
  console.error('  and control-plane actions are kept for 90 days in event history only.');
  console.error('  Deploy with the default (platformTrail on), or point an organization trail at this account.');
  process.exit(1);
}
console.log(`[audit-trail] ok: management events logged by ${logging.join(', ')}`);
