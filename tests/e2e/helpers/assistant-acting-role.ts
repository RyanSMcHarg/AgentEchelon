/**
 * THE ROLE EVERY ASSISTANT OF A CLASSIFICATION ACTS THROUGH, FOUND IN THE DEPLOYMENT AND ASKED ABOUT.
 *
 * Each classification has one acting role (`assistantActingRole` in `agent-classification-common.ts`).
 * The vend assumes it once per turn and tags the session with `assistant`, `classification`, `role`
 * and `bot`, and every statement on the role and its boundary compares those tags. Nothing about a
 * particular assistant is written into IAM, so the question "what may this assistant do" is asked by
 * simulating the acting role WITH the tags its session would carry.
 *
 * ── HOW THE ROLE IS FOUND ───────────────────────────────────────────────────────────────────────
 *
 * By its IAM path and then by its own trust policy, not by its name. Every acting role lives under
 * `/{instance}/assistant/`, and its trust policy pins `aws:RequestTag/classification` to the one
 * classification it serves. The generated role name cannot be relied on to say which classification
 * it is: CloudFormation truncates the stack part of a generated name to fit 64 characters, and a long
 * logical id leaves too little room for the `-Pr-` / `-St-` abbreviation the other roles keep. The
 * trust policy is the deployed statement of which classification the role is for, so it is also the
 * right thing to select on.
 *
 * Several specs share these lookups, which is why they live here: the boundary, the ops cut, the
 * CloudWatch boundary, the context and model boundaries, and the trust spec all ask about the same
 * principals, and six private copies of "find the acting role" would drift six ways.
 *
 * `execSync` and the AWS CLI rather than the SDK, matching the IAM specs this replaces.
 */
import { STACK_PREFIX, INSTANCE, SSM_ROOT, stackName, physicalIdsIn } from './stack-prefix';
import { aws, awsOrNull } from './aws';

export { awsOrNull };
/** One AWS call that must succeed. Use it where a failure is a failure, such as a simulation. */
export function awsJson(args: string): any {
  return aws(args, { maxBufferMb: 10, quiet: true });
}

export { STACK_PREFIX, INSTANCE, SSM_ROOT };
export const REGION = process.env.AWS_REGION || 'us-east-1';
export const ASSISTANT_ROLE_PATH = `/${INSTANCE}/assistant/`;

/** The three shipped classifications. `probe` is a measurement classification and may be absent. */
export const CLASSIFICATIONS = ['basic', 'standard', 'premium'] as const;

/** The session tag condition keys. One spelling each, so a typo cannot be made twice. */
export const TAG = {
  role: 'aws:PrincipalTag/role',
  bot: 'aws:PrincipalTag/bot',
  classification: 'aws:PrincipalTag/classification',
  assistant: 'aws:PrincipalTag/assistant',
  resourceClassification: 'aws:ResourceTag/classification',
} as const;

let reachable: boolean | undefined;
/**
 * WHETHER THIS RUN CAN ASK AWS ANYTHING AT ALL.
 *
 * Asked of STS rather than inferred from environment variables, because a profile, SSO or an instance
 * role all supply credentials without setting `AWS_ACCESS_KEY_ID`. A run with no credentials skips
 * these specs by name; a run WITH credentials whose deployment lacks the role fails, which is the
 * distinction that matters.
 */
export function awsReachable(): boolean {
  if (reachable === undefined) reachable = !!awsOrNull('sts get-caller-identity --query Account');
  return reachable;
}
export const NO_AWS_REASON = 'needs AWS credentials to read and simulate the deployed IAM roles';

/** A simulator context entry. Quoted, so it survives `cmd.exe` and POSIX shells alike. */
export function ctx(key: string, value: string): string {
  return `"ContextKeyName=${key},ContextKeyValues=${value},ContextKeyType=string"`;
}

/**
 * AWS's decision for one deployed principal, one action and one resource, with the session and
 * resource context supplied.
 *
 * ONE RESOURCE PER CALL. Several `--resource-arns` for one action collapse into one templated result
 * (see `a-classification-is-denied-a-model-it-does-not-declare.spec.ts`), so a batched answer is about
 * the action rather than the resource.
 *
 * THROWS RATHER THAN RETURNING "unknown". A failed simulation read as "not allowed" would satisfy every
 * denial in these specs while proving nothing.
 *
 * The simulator evaluates the role's permissions boundary as well as its identity policies, so a
 * decision here is what the classification boundary and the grant decide together.
 */
export function decide(principalArn: string, action: string, resourceArn: string, context: string[] = []): string {
  const entries = context.length ? `--context-entries ${context.join(' ')} ` : '';
  const res = awsJson(
    `iam simulate-principal-policy --policy-source-arn ${principalArn} `
    + `--action-names ${action} --resource-arns "${resourceArn}" ${entries}`
    + '--query "EvaluationResults[0].EvalDecision"',
  );
  if (typeof res !== 'string') {
    throw new Error(`simulate-principal-policy returned no decision for ${action} on ${resourceArn}`);
  }
  return res;
}

/**
 * Which policies produced a decision: the `SourcePolicyId` of every statement the simulator matched. A
 * managed policy is named by its policy name, an inline one by its name on the role. Used where WHICH
 * layer refused matters, not only that something did.
 */
export function decisionSources(principalArn: string, action: string, resourceArn: string, context: string[] = []): { decision: string; sources: string[] } {
  const entries = context.length ? `--context-entries ${context.join(' ')} ` : '';
  const res = awsJson(
    `iam simulate-principal-policy --policy-source-arn ${principalArn} `
    + `--action-names ${action} --resource-arns "${resourceArn}" ${entries}`
    + '--query "EvaluationResults[0].{d:EvalDecision,s:MatchedStatements[].SourcePolicyId}"',
  );
  if (!res || typeof res.d !== 'string') throw new Error(`simulate-principal-policy returned no decision for ${action} on ${resourceArn}`);
  return { decision: res.d, sources: res.s ?? [] };
}

/** The role NAME from its ARN. A pathed role's name is the last segment, not everything after `role/`. */
export const roleNameOf = (arn: string) => arn.split('/').pop() || '';

const asList = (v: unknown): string[] => (v === undefined || v === null ? [] : ([] as string[]).concat(v as string[]));

export interface ActingRole {
  arn: string;
  name: string;
  trust: any;
  /** The assistant roles the trust policy lets the vend mint (`aws:RequestTag/role`). */
  declaredRoles: string[];
}

/** The trust statement granting `sts:AssumeRole`, which is where the session pins have to live. */
export function assumeStatement(trust: any): any | undefined {
  return (trust?.Statement ?? []).find((s: any) => asList(s.Action).includes('sts:AssumeRole'));
}

/** A condition value from a statement, under any operator, as a list. */
export function conditionValues(statement: any, operator: string, key: string): string[] {
  const block = statement?.Condition?.[operator] ?? {};
  const hit = Object.keys(block).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? asList(block[hit]) : [];
}

let actingRoles: Array<{ RoleName: string; Arn: string; AssumeRolePolicyDocument: any }> | undefined;
function listActingRoles() {
  if (!actingRoles) {
    actingRoles = (awsOrNull(`iam list-roles --path-prefix ${ASSISTANT_ROLE_PATH}`)?.Roles ?? [])
      .filter((r: any) => /AssistantActing/.test(r.RoleName));
  }
  return actingRoles!;
}

/** The acting role for one classification, selected by the classification its trust policy pins. */
export function actingRole(classification: string): ActingRole | null {
  for (const r of listActingRoles()) {
    let trust = r.AssumeRolePolicyDocument;
    if (typeof trust === 'string') trust = JSON.parse(decodeURIComponent(trust));
    const assume = assumeStatement(trust);
    const pinned = conditionValues(assume, 'StringEquals', 'aws:RequestTag/classification');
    if (pinned.length === 1 && pinned[0] === classification) {
      return {
        arn: r.Arn,
        name: r.RoleName,
        trust,
        declaredRoles: conditionValues(assume, 'StringEquals', 'aws:RequestTag/role'),
      };
    }
  }
  return null;
}

export interface AssistantBot {
  botArn: string;
  botId: string;
  assistant: string;
  role: string;
  classificationTag: string;
}

const botCache = new Map<string, AssistantBot[]>();
/**
 * The assistants assigned in one classification, from the same assignment records the vend reads,
 * each with the `classification` tag its bot actually carries. The tag is READ rather than assumed,
 * because the simulator cannot fetch Amazon Chime SDK resource tags and is handed the value instead.
 */
export function assistantBots(classification: string): AssistantBot[] {
  const cached = botCache.get(classification);
  if (cached) return cached;
  const params: Array<{ Value: string }> = awsOrNull(
    `ssm get-parameters-by-path --path "${SSM_ROOT}/assistant-assignments/${classification}" --recursive `
    + '--query "Parameters[].{Value:Value}"',
  ) || [];
  const seen = new Set<string>();
  const out: AssistantBot[] = [];
  for (const p of params) {
    let v: { botArn?: string; assistant?: string | null; role?: string } = {};
    try { v = JSON.parse(p.Value || '{}'); } catch { continue; }
    if (!v.botArn || !v.assistant || !v.role || seen.has(v.botArn)) continue;
    seen.add(v.botArn);
    const tags: Array<{ Key: string; Value: string }> = awsOrNull(
      `chime-sdk-identity list-tags-for-resource --resource-arn ${v.botArn} --query "Tags"`,
    ) || [];
    out.push({
      botArn: v.botArn,
      botId: v.botArn.split('/').pop() || '',
      assistant: v.assistant,
      role: v.role,
      classificationTag: tags.find((t) => t.Key === 'classification')?.Value || '',
    });
  }
  botCache.set(classification, out);
  return out;
}

/** The first assigned bot holding `role` in a classification. */
export function botFor(classification: string, role: string): AssistantBot | null {
  return assistantBots(classification).find((b) => b.role === role) ?? null;
}

/** The app instance, from a real bot ARN (`…:app-instance/{id}/bot/{botId}`). */
export function appInstanceArn(): string | null {
  for (const c of CLASSIFICATIONS) {
    const b = assistantBots(c)[0];
    if (b) return b.botArn.split('/bot/')[0];
  }
  return null;
}

/**
 * The session tags a turn for `bot` would carry, as simulator context. These are exactly the four
 * the vend stamps (`assistant-vend.ts`), so a decision here is a decision about a real session.
 */
export function sessionContext(classification: string, role: string, botId: string, assistant = 'probe'): string[] {
  return [
    ctx(TAG.classification, classification),
    ctx(TAG.role, role),
    ctx(TAG.bot, botId),
    ctx(TAG.assistant, assistant),
  ];
}

/** A Lambda's execution role, by the SSM parameter that publishes the function ARN. */
function roleOfFunctionAt(param: string): string | null {
  const fn = awsOrNull(`ssm get-parameter --name "${param}" --query "Parameter.Value"`);
  if (typeof fn !== 'string') return null;
  const role = awsOrNull(`lambda get-function-configuration --function-name ${fn} --query "Role"`);
  return typeof role === 'string' ? role : null;
}

/** The async processor's role: bootstrap only (logs, invoke the vend, admin alert). */
export const processorRoleArn = (c: string) => roleOfFunctionAt(`${SSM_ROOT}/assistant/${c}/processor-arn`);
/** The router (Lex fulfillment) handler's role. */
export const handlerRoleArn = (c: string) => roleOfFunctionAt(`${SSM_ROOT}/assistant/${c}/router-arn`);
/** The vend's role: the only principal an acting role trusts. */
export const vendRoleArn = (c: string) => roleOfFunctionAt(`${SSM_ROOT}/assistant/${c}/vend-arn`);
/** The battle orchestrator's role. Null when battle is not deployed (`battle` is not a declared capability). */
export const battleOrchestratorRoleArn = () => roleOfFunctionAt(`${SSM_ROOT}/shared/battle-orchestrator-arn`);

/** The channel flow processor's role, read by its construct id from this instance's ChannelFlow stack. */
export function channelFlowProcessorRoleArn(): string | null {
  let name: string | undefined;
  try {
    [name] = physicalIdsIn([stackName('ChannelFlow')], { type: 'AWS::IAM::Role', logicalId: /^ChannelFlowProcessorRole/ });
  } catch {
    return null;
  }
  return name ? roleArn(name) : null;
}

/** A role's ARN by its name, or null when it cannot be read. */
export function roleArn(name: string): string | null {
  const arn = awsOrNull(`iam get-role --role-name ${name} --query "Role.Arn"`);
  return typeof arn === 'string' && arn.startsWith('arn:') ? arn : null;
}

/** The context bucket, read off the deployed processor's environment. */
export function contextBucket(classification: string): string | null {
  const fn = awsOrNull(`ssm get-parameter --name "${SSM_ROOT}/assistant/${classification}/processor-arn" --query "Parameter.Value"`);
  if (typeof fn !== 'string') return null;
  const b = awsOrNull(`lambda get-function-configuration --function-name ${fn} --query "Environment.Variables.CONTEXT_BUCKET"`);
  return typeof b === 'string' ? b : null;
}
