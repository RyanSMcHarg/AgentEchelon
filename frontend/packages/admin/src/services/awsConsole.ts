/**
 * AWS-console deep-link helpers for the admin troubleshooting surface.
 *
 * A profile MANIFEST is deliberately instance-agnostic — it carries catalog model KEYS, never ARNs,
 * account ids, or region (SPEC-PORTABLE §5), so it stays portable across instances. That means the
 * console can't read a Bedrock/IAM/Lambda link out of the manifest; it derives the region from the
 * (instance-bound) API URL and builds best-effort console links from the logical values. The console
 * uses the operator's currently-signed-in account, so account id is not needed in the URL.
 *
 * These links land the operator on the right SERVICE + region for a resource; precise per-resource deep
 * links (an exact IAM role ARN, the Lambda that hosts a given tool) need the backend to expose the
 * resolved ARNs (a separate, instance-bound "live" view) — tracked as the follow-up.
 */

/** Region parsed from the manage-profiles API host (`{id}.execute-api.{region}.amazonaws.com`). */
export function awsRegion(): string {
  try {
    const raw = import.meta.env.VITE_MANAGE_PROFILES_API_URL as string | undefined;
    if (raw) {
      const host = new URL(raw).host;
      const m = host.match(/\.([a-z]{2}-[a-z]+-\d)\.amazonaws\.com$/);
      if (m) return m[1];
    }
  } catch {
    /* fall through to default */
  }
  return 'us-east-1';
}

const base = (region: string) => `https://${region}.console.aws.amazon.com`;

/** Bedrock model catalog (region-scoped) — where an operator inspects/enables a foundation model. */
export function bedrockModelsUrl(region = awsRegion()): string {
  return `${base(region)}/bedrock/home?region=${region}#/model-catalog`;
}

/** Bedrock guardrails list (region-scoped) — fallback when no specific guardrail id is resolved. */
export function bedrockGuardrailsUrl(region = awsRegion()): string {
  return `${base(region)}/bedrock/home?region=${region}#/guardrails`;
}

/** Deep link to a SPECIFIC Bedrock guardrail's config (the one the assistant actually applies). */
export function bedrockGuardrailUrl(guardrailId: string, region = awsRegion()): string {
  return `${base(region)}/bedrock/home?region=${region}#/guardrails/${encodeURIComponent(guardrailId)}`;
}

/** Lambda functions list (region-scoped) — fallback when no specific function is resolved. */
export function lambdaFunctionsUrl(region = awsRegion()): string {
  return `${base(region)}/lambda/home?region=${region}#/functions`;
}

/** Deep link to a SPECIFIC Lambda function (the Converse tool loop that runs a profile's tools). */
export function lambdaFunctionUrl(functionName: string, region = awsRegion()): string {
  return `${base(region)}/lambda/home?region=${region}#/functions/${encodeURIComponent(functionName)}`;
}

/** Lambda functions list pre-FILTERED by a search term (for a resource whose exact name isn't resolved,
 *  e.g. the shared channel-flow processor). */
export function lambdaFunctionsSearchUrl(term: string, region = awsRegion()): string {
  return `${base(region)}/lambda/home?region=${region}#/functions?fo=and&o0=%3A&v0=${encodeURIComponent(term)}`;
}

/** IAM roles list (IAM is global — no region in the URL). */
export function iamRolesUrl(): string {
  return `https://console.aws.amazon.com/iam/home#/roles`;
}

/**
 * Deep link to a Lambda's CloudWatch Logs, optionally pre-filtered to a term (e.g. a tool name) so an
 * operator sees THAT tool's actual invocations — the closest thing to "the specific logic" for a code tool
 * (tools have no per-tool AWS resource; they run inside the processor Lambda). The CloudWatch console
 * fragment double-encodes `/` as `$252F` and encodes `?`/`=` as `$3F`/`$3D`.
 */
export function cloudwatchLogsUrl(functionName: string, filterTerm?: string, region = awsRegion()): string {
  const lg = `/aws/lambda/${functionName}`.replace(/\//g, '$252F');
  const filter = filterTerm ? `$3FfilterPattern$3D${encodeURIComponent(`"${filterTerm}"`)}` : '';
  return `${base(region)}/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${lg}/log-events${filter}`;
}

/** Deep link to a SPECIFIC IAM role's detail page (the assistant identity's role). */
export function iamRoleUrl(roleName: string): string {
  return `https://console.aws.amazon.com/iam/home#/roles/details/${encodeURIComponent(roleName)}`;
}
