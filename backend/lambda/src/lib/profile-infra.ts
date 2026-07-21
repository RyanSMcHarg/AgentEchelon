/**
 * Resolve the INSTANCE-BOUND identifiers for a profile's live assistant, for the admin console's AWS
 * troubleshooting deep links. A profile MANIFEST is deliberately ARN/region/account-free (portable,
 * SPEC-PORTABLE §5), so the console cannot read a Bedrock/IAM/Lambda link out of it. These come from LIVE
 * infra instead: the processor Lambda ARN is published to SSM (`/assistant/{name}/processor-arn`), and its
 * `GetFunctionConfiguration` yields the execution role (the assistant identity) + the `GUARDRAIL_ID` env
 * (the guardrail it actually applies). Best-effort: never throws — a transient failure just drops a link.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';

export interface ResolvedInfra {
  region: string;
  /** The Converse-tool-loop / async-processor Lambda (where a tool is debugged). */
  processorArn?: string;
  processorFunctionName?: string;
  /** The classification's router / Lex-fulfillment (AgentHandler) Lambda — classification-level, shared by
   *  every profile at this classification (intent classification + routing happen here). */
  routerArn?: string;
  routerFunctionName?: string;
  /** The assistant identity's execution role (what it may reach). */
  roleArn?: string;
  roleName?: string;
  /** The Bedrock guardrail the assistant applies out-of-band on the final reply. */
  guardrailId?: string;
  /** The Amazon Chime SDK channel flow associated with this instance's conversations. A SINGLE shared
   *  app-instance flow (`/channel-flow-arn`) routes every channel (@all fan-out, /battle, classification-tag
   *  routing) and STAYS; the roadmap layers additional per-classification/profile flows on top of a slimmed
   *  routing flow, not a per-classification swap (which would break routing). */
  channelFlowArn?: string;
}

export async function resolveProfileInfra(
  ssm: SSMClient,
  lambda: LambdaClient,
  ssmRoot: string,
  profileName: string,
  region: string,
): Promise<ResolvedInfra> {
  const out: ResolvedInfra = { region };
  const fnName = (arn: string) => arn.split(':function:')[1]?.split(':')[0]; // arn:...:function:{name}[:{qual}]
  try {
    const p = await ssm.send(new GetParameterCommand({ Name: `${ssmRoot}/assistant/${profileName}/processor-arn` }));
    const arn = p.Parameter?.Value;
    if (!arn) return out;
    out.processorArn = arn;
    out.processorFunctionName = fnName(arn);
    const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: arn }));
    out.roleArn = cfg.Role;
    out.roleName = cfg.Role?.split('/').pop();
    out.guardrailId = cfg.Environment?.Variables?.GUARDRAIL_ID || undefined;
  } catch (err) {
    // Missing param (profile has no live processor yet) or a denied/absent function — drop the links, don't fail the list.
    console.warn(`[profile-infra] could not resolve infra for '${profileName}':`, (err as { name?: string })?.name ?? err);
  }
  // The router/AgentHandler ARN (classification-level) is a separate SSM param; resolve it independently so
  // a missing/legacy router param never drops the processor links above.
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: `${ssmRoot}/assistant/${profileName}/router-arn` }));
    if (r.Parameter?.Value) {
      out.routerArn = r.Parameter.Value;
      out.routerFunctionName = fnName(r.Parameter.Value);
    }
  } catch {
    /* no router-arn yet (pre-redeploy) — omit the link */
  }
  // The channel flow associated with this instance's conversations (shared today; per-classification is roadmap).
  try {
    const cf = await ssm.send(new GetParameterCommand({ Name: `${ssmRoot}/channel-flow-arn` }));
    if (cf.Parameter?.Value) out.channelFlowArn = cf.Parameter.Value;
  } catch {
    /* no channel-flow param — omit */
  }
  return out;
}
