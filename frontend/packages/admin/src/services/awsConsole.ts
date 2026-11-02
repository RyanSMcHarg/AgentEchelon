/**
 * AWS-console deep-link builders for the admin troubleshooting surface.
 *
 * A profile MANIFEST is instance-agnostic (catalog keys, never ARNs, account ids or region: SPEC-PORTABLE §5),
 * so the identifiers come from the server's live resolution (`resolved` on a listing, `lib/profile-infra.ts`).
 * Every builder takes the region the resource was resolved in; `awsRegion()` is only the default for a caller
 * that has none. The console signs into the operator's own account, so no account id is in a URL.
 *
 * URL FORMATS, AND HOW EACH WAS CHECKED (2026-10-23). The AWS console publishes no URL contract, so each
 * format is the one the console itself navigates to, and a format that could not be confirmed is said so:
 *   - Lambda function `lambda/home?region=R#/functions/NAME`: the console's own route for a function.
 *   - CloudWatch Logs `cloudwatch/home?region=R#logsV2:log-groups/log-group/G[/log-events$3FfilterPattern$3DP]`:
 *     the fragment is URL-encoded twice and `%` written as `$`, so `/` is `$252F` and `"` is `$2522`, while
 *     the `?` and `=` that separate the fragment's own query are encoded once (`$3F`, `$3D`).
 *   - IAM role `iam/home#/roles/details/NAME`: by name, not ARN, whatever the role's path.
 *   - IAM policy `iam/home#/policies/details/ENCODED_ARN`: the current IAM console's policy page.
 *   - Amazon Lex V2 bot `lexv2/home?region=R#bot/BOT_ID`.
 *   - Systems Manager parameter `systems-manager/parameters/NAME/description?region=R&tab=Table`, the name
 *     without its leading slash.
 *   - S3 prefix `s3/buckets/BUCKET?region=R&prefix=P&showversions=false`.
 *   - Amazon Bedrock guardrail `bedrock/home?region=R#/guardrails/guardrail/NAME/ID`: the console's detail
 *     route takes the guardrail's name and id, so the server resolves the name from the classification's
 *     catalog. Not confirmable from published documentation; a guardrail whose name is unknown links to the list.
 *   - Amazon Chime SDK channel flows and AppInstanceBots have NO console page: AWS documents both as managed
 *     through the API and the CLI only (Amazon Chime SDK Developer Guide, "Using AppInstanceBots as
 *     intelligent channel agents" and "Using channel flows to process messages"). The console shows their
 *     ARN and the CLI command that describes them (`describeCommand`), and links the Lambda a flow invokes
 *     and the Amazon Lex bot an AppInstanceBot invokes, which are the resources an operator debugs.
 */

/** Region parsed from the admin API host (`{id}.execute-api.{region}.amazonaws.com`). */
export function awsRegion(): string {
  try {
    const raw = import.meta.env.VITE_ADMIN_API_URL as string | undefined;
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

/** CloudWatch's fragment encoding: encoded twice, with `%` written as `$`. */
export const cloudwatchFragment = (s: string): string => encodeURIComponent(encodeURIComponent(s)).replace(/%/g, '$');

/** Bedrock model catalog (region-scoped): where an operator inspects or enables a foundation model. */
export function bedrockModelsUrl(region = awsRegion()): string {
  return `${base(region)}/bedrock/home?region=${region}#/model-catalog`;
}

/** Bedrock guardrails list, for a guardrail whose name is not resolved. */
export function bedrockGuardrailsUrl(region = awsRegion()): string {
  return `${base(region)}/bedrock/home?region=${region}#/guardrails`;
}

/** One Bedrock guardrail's page: the console's route names it by name and id. */
export function bedrockGuardrailUrl(guardrailName: string, guardrailId: string, region = awsRegion()): string {
  return `${base(region)}/bedrock/home?region=${region}#/guardrails/guardrail/${encodeURIComponent(guardrailName)}/${encodeURIComponent(guardrailId)}`;
}

/** Lambda functions list (region-scoped). */
export function lambdaFunctionsUrl(region = awsRegion()): string {
  return `${base(region)}/lambda/home?region=${region}#/functions`;
}

/** One Lambda function. */
export function lambdaFunctionUrl(functionName: string, region = awsRegion()): string {
  return `${base(region)}/lambda/home?region=${region}#/functions/${encodeURIComponent(functionName)}`;
}

/** Lambda functions filtered by a search term, for a resource the server did not resolve. */
export function lambdaFunctionsSearchUrl(term: string, region = awsRegion()): string {
  return `${base(region)}/lambda/home?region=${region}#/functions?fo=and&o0=%3A&v0=${encodeURIComponent(term)}`;
}

/** One CloudWatch log group's events, optionally filtered to a quoted term (e.g. a tool name). */
export function cloudwatchLogGroupUrl(logGroup: string, filterTerm?: string, region = awsRegion()): string {
  const filter = filterTerm ? `/log-events$3FfilterPattern$3D${cloudwatchFragment(`"${filterTerm}"`)}` : '';
  return `${base(region)}/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${cloudwatchFragment(logGroup)}${filter}`;
}

/** A Lambda function's log group, optionally filtered to a term. */
export function cloudwatchLogsUrl(functionName: string, filterTerm?: string, region = awsRegion()): string {
  return cloudwatchLogGroupUrl(`/aws/lambda/${functionName}`, filterTerm, region);
}

/** IAM roles list (IAM is global: no region in the URL). */
export function iamRolesUrl(): string {
  return 'https://console.aws.amazon.com/iam/home#/roles';
}

/** One IAM role, by name. */
export function iamRoleUrl(roleName: string): string {
  return `https://console.aws.amazon.com/iam/home#/roles/details/${encodeURIComponent(roleName)}`;
}

/** One IAM managed policy, by ARN. */
export function iamPolicyUrl(policyArn: string): string {
  return `https://console.aws.amazon.com/iam/home#/policies/details/${encodeURIComponent(policyArn)}`;
}

/** One Amazon Lex V2 bot. */
export function lexBotUrl(botId: string, region = awsRegion()): string {
  return `${base(region)}/lexv2/home?region=${region}#bot/${encodeURIComponent(botId)}`;
}

/** One Systems Manager parameter. */
export function ssmParameterUrl(name: string, region = awsRegion()): string {
  const path = name.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
  return `${base(region)}/systems-manager/parameters/${path}/description?region=${region}&tab=Table`;
}

/** One S3 prefix in a bucket. */
export function s3PrefixUrl(bucket: string, prefix: string, region = awsRegion()): string {
  return `${base(region)}/s3/buckets/${encodeURIComponent(bucket)}?region=${region}&prefix=${encodeURIComponent(prefix)}&showversions=false`;
}

/**
 * The CLI command that describes an Amazon Chime SDK resource with no console page: a channel flow or an
 * AppInstanceBot (see the header).
 */
export function describeCommand(arn: string, region = awsRegion()): string {
  if (/:app-instance\/[^/]+\/channel-flow\//.test(arn)) {
    return `aws chime-sdk-messaging describe-channel-flow --channel-flow-arn ${arn} --region ${region}`;
  }
  return `aws chime-sdk-identity describe-app-instance-bot --app-instance-bot-arn ${arn} --region ${region}`;
}
