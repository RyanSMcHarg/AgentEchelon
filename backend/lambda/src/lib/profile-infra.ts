/**
 * WHERE AN ASSISTANT LIVES IN AWS, for the admin console's troubleshooting links.
 *
 * A profile MANIFEST is deliberately ARN/region/account-free (portable, SPEC-PORTABLE §5), so the console
 * cannot read a Lambda, IAM or Amazon Lex link out of it. These come from the live deployment instead.
 *
 * TWO KINDS OF RESOURCE, AND THE CONSOLE HAS TO SAY WHICH IS WHICH (ADR-054):
 *   - PER ASSISTANT: its identity (the `AppInstanceBot`), its Amazon Lex bot and alias, its versioned
 *     definition parameter, its assignment record, and its profile body prefix.
 *   - SHARED BY EVERY ASSISTANT OF ITS CLASSIFICATION: the processor (the Converse tool loop), the router
 *     (Lex fulfillment), the acting role every turn assumes and its permissions boundary, the guardrail the
 *     processor applies by default, the classification's document templates, and the Lex conversation logs.
 *   - SHARED BY THE DEPLOYMENT: the one app-instance channel flow and the Lambda it invokes.
 *
 * KEYED BY CLASSIFICATION. The stack publishes `processor-arn`, `router-arn` and `vend-arn` under
 * `/assistant/{classification}/` (`processorArnKey`, `routerArnKey` in agent-classification-common.ts). Reading
 * them under the assistant's own name found nothing for every assistant whose name is not its classification,
 * which is all of them, so every link fell back to a list page.
 *
 * Best-effort: never throws. A read that fails drops its link and nothing else.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { DescribeAppInstanceBotCommand, type ChimeSDKIdentityClient } from '@aws-sdk/client-chime-sdk-identity';
import { DescribeChannelFlowCommand, type ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { DescribeBotAliasCommand, type LexModelsV2Client } from '@aws-sdk/client-lex-models-v2';
import { GetRoleCommand, type IAMClient } from '@aws-sdk/client-iam';

/** Who a resource belongs to: this assistant alone, its classification's assistants, or the deployment. */
export type InfraScope = 'assistant' | 'classification' | 'deployment';

/** Where an S3 prefix is. */
export interface S3Prefix { bucket: string; prefix: string }

export interface ResolvedInfra {
  region: string;
  classification?: string;
  role?: string;
  /** Which scope each resolved resource has, by field name, so the console labels shared resources. */
  scopes: Record<string, InfraScope>;

  // ── this assistant's own ──
  /** The `AppInstanceBot` the assistant answers as. */
  botArn?: string;
  /** Its Amazon Lex V2 bot and the alias the identity invokes. */
  lexBotId?: string;
  lexBotAliasId?: string;
  /** The versioned definition parameter (`{root}/assistant/{name}/definition`). */
  definitionParam?: string;
  /** The assignment record that places it in its classification and role. */
  assignmentParam?: string;
  /** Its directory entry, which every provisioner-owned assistant has. */
  directoryParam?: string;
  /** Where its persona and intent pack bodies are stored. */
  profileBodies?: S3Prefix;

  // ── shared by the classification's assistants ──
  processorArn?: string;
  processorFunctionName?: string;
  routerArn?: string;
  routerFunctionName?: string;
  /** The role every turn of this classification acts through, one tagged session per turn. */
  actingRoleArn?: string;
  actingRoleName?: string;
  /** The managed policy that bounds the acting role. */
  boundaryPolicyArn?: string;
  boundaryPolicyName?: string;
  /** The guardrail the processor applies by default, and its name from the classification's catalog. */
  guardrailId?: string;
  guardrailName?: string;
  /** The classification's document templates: bodies under this prefix, pointers under this SSM path. */
  templates?: S3Prefix;
  templatePointerPath?: string;
  /** The Amazon Lex conversation log group the assistant's alias writes to. */
  lexLogGroup?: string;

  // ── shared by the deployment ──
  /** The app-instance channel flow, and the Lambda it invokes, read from the flow itself. */
  channelFlowArn?: string;
  channelFlowProcessorArn?: string;
  channelFlowProcessorFunctionName?: string;
}

/** Where the caller already knows the assistant sits, and the identities it answers as. */
export interface InfraPlacement {
  classification?: string;
  role?: string;
  /** Owned by the provisioner (ADR-048, amended 2026-10-23): it has a directory entry and a record of its own. */
  provisioned?: boolean;
  /** A duel's alt, whose record is its role's `alt` record. */
  alt?: boolean;
  botArns?: string[];
  lexBotId?: string;
}

export interface InfraClients {
  ssm: SSMClient;
  lambda: LambdaClient;
  chimeIdentity?: ChimeSDKIdentityClient;
  chimeMessaging?: ChimeSDKMessagingClient;
  lex?: LexModelsV2Client;
  iam?: IAMClient;
}

export interface InfraOptions {
  ssmRoot: string;
  region: string;
  /** The bucket profile bodies and templates are stored in (`bodyBucket()`). */
  bodyBucket?: string;
}

/** `arn:...:function:{name}[:{qualifier}]` to `{name}`. */
export const functionNameOf = (arn: string): string | undefined => arn.split(':function:')[1]?.split(':')[0];

/** The classification-keyed parameters the stack publishes (agent-classification-common.ts). */
export const classificationParam = (ssmRoot: string, classification: string, leaf: 'processor-arn' | 'router-arn' | 'vend-arn' | 'guardrails') =>
  `${ssmRoot}/assistant/${classification}/${leaf}`;

/**
 * AN ASSISTANT'S ASSIGNMENT RECORD, ONE PATH FOR EVERY LIVE ASSISTANT however it was asked for
 * (`runtimeAssignmentParamName`), and its role's `alt` record for a duel's alt.
 */
export const assignmentParam = (ssmRoot: string, classification: string, role: string, assistant: string, alt = false) =>
  alt
    ? `${ssmRoot}/assistant-assignments/${classification}/${role}/alt`
    : `${ssmRoot}/assistant-assignments/${classification}/${role}/assistants/${assistant}`;

const warn = (what: string, err: unknown) =>
  console.warn(`[profile-infra] could not resolve ${what}:`, (err as { name?: string })?.name ?? err);

async function param(ssm: SSMClient, name: string): Promise<string | undefined> {
  const r = await ssm.send(new GetParameterCommand({ Name: name }));
  return r.Parameter?.Value || undefined;
}

/** `arn:aws:lex:{region}:{account}:bot-alias/{botId}/{aliasId}` to its two ids. */
export function lexAliasOf(arn: string | undefined): { botId: string; aliasId: string } | undefined {
  const m = /:bot-alias\/([^/]+)\/([^/]+)$/.exec(arn ?? '');
  return m ? { botId: m[1], aliasId: m[2] } : undefined;
}

/**
 * A resolver for one listing. Classification- and deployment-level reads are memoized, so a listing of
 * twenty assistants in three classifications reads each classification's processor once.
 */
export function createInfraResolver(clients: InfraClients, opts: InfraOptions) {
  const { ssm, lambda } = clients;
  const { ssmRoot, region } = opts;
  const perClassification = new Map<string, Promise<Partial<ResolvedInfra>>>();
  let deployment: Promise<Partial<ResolvedInfra>> | undefined;

  const classificationLevel = (c: string): Promise<Partial<ResolvedInfra>> => {
    const held = perClassification.get(c);
    if (held) return held;
    const p = (async () => {
      const out: Partial<ResolvedInfra> = {};
      try {
        const arn = await param(ssm, classificationParam(ssmRoot, c, 'processor-arn'));
        if (arn) {
          out.processorArn = arn;
          out.processorFunctionName = functionNameOf(arn);
          const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: arn }));
          out.guardrailId = cfg.Environment?.Variables?.GUARDRAIL_ID || undefined;
        }
      } catch (err) { warn(`the ${c} processor`, err); }
      try {
        const arn = await param(ssm, classificationParam(ssmRoot, c, 'router-arn'));
        if (arn) { out.routerArn = arn; out.routerFunctionName = functionNameOf(arn); }
      } catch (err) { warn(`the ${c} router`, err); }
      // THE ACTING ROLE IS THE VEND'S `ACTING_ROLE_ARN`: the vend is the one principal that assumes it, so its
      // configuration names the role exactly. Its boundary is read off the role rather than rebuilt by name.
      try {
        const vend = await param(ssm, classificationParam(ssmRoot, c, 'vend-arn'));
        if (vend) {
          const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: vend }));
          const role = cfg.Environment?.Variables?.ACTING_ROLE_ARN;
          if (role) {
            out.actingRoleArn = role;
            out.actingRoleName = role.split('/').pop();
            if (clients.iam && out.actingRoleName) {
              const r = await clients.iam.send(new GetRoleCommand({ RoleName: out.actingRoleName }));
              const b = r.Role?.PermissionsBoundary?.PermissionsBoundaryArn;
              if (b) { out.boundaryPolicyArn = b; out.boundaryPolicyName = b.split('/').pop(); }
            }
          }
        }
      } catch (err) { warn(`the ${c} acting role`, err); }
      // The guardrail's NAME is on the classification's catalog, beside its id; the console's page needs both.
      try {
        const raw = await param(ssm, classificationParam(ssmRoot, c, 'guardrails'));
        const catalog = raw ? JSON.parse(raw) as Array<{ guardrailId?: string; name?: string }> : [];
        const hit = Array.isArray(catalog) ? catalog.find((g) => g.guardrailId === out.guardrailId) : undefined;
        if (hit?.name) out.guardrailName = hit.name;
      } catch (err) { warn(`the ${c} guardrail catalog`, err); }
      if (opts.bodyBucket) out.templates = { bucket: opts.bodyBucket, prefix: `templates/${c}/` };
      out.templatePointerPath = `${ssmRoot}/assistant/${c}/templates`;
      return out;
    })();
    perClassification.set(c, p);
    return p;
  };

  const deploymentLevel = (): Promise<Partial<ResolvedInfra>> => {
    if (deployment) return deployment;
    deployment = (async () => {
      const out: Partial<ResolvedInfra> = {};
      try {
        out.channelFlowArn = await param(ssm, `${ssmRoot}/channel-flow-arn`);
      } catch (err) { warn('the channel flow', err); }
      // THE FLOW'S OWN PROCESSOR, read from the flow, so the link is the Lambda it invokes and never a search.
      if (out.channelFlowArn && clients.chimeMessaging) {
        try {
          const r = await clients.chimeMessaging.send(new DescribeChannelFlowCommand({ ChannelFlowArn: out.channelFlowArn }));
          const arn = r.ChannelFlow?.Processors?.[0]?.Configuration?.Lambda?.ResourceArn;
          if (arn) { out.channelFlowProcessorArn = arn; out.channelFlowProcessorFunctionName = functionNameOf(arn); }
        } catch (err) { warn('the channel flow processor', err); }
      }
      return out;
    })();
    return deployment;
  };

  return async function resolve(profileName: string, placement: InfraPlacement = {}): Promise<ResolvedInfra> {
    const out: ResolvedInfra = { region, scopes: {} };
    const own = (field: keyof ResolvedInfra) => { out.scopes[field] = 'assistant'; };
    try {
      const c = placement.classification;
      out.definitionParam = `${ssmRoot}/assistant/${profileName}/definition`;
      own('definitionParam');
      if (opts.bodyBucket) { out.profileBodies = { bucket: opts.bodyBucket, prefix: `profiles/${profileName}/` }; own('profileBodies'); }
      if (c) {
        out.classification = c;
        if (placement.role) out.role = placement.role;
        if (placement.role && (placement.provisioned || placement.alt)) {
          out.assignmentParam = assignmentParam(ssmRoot, c, placement.role, profileName, placement.alt === true);
          own('assignmentParam');
        }
        if (placement.provisioned) { out.directoryParam = `${ssmRoot}/assistant-directory/${profileName}`; own('directoryParam'); }
        const shared = await classificationLevel(c);
        Object.assign(out, shared);
        for (const k of Object.keys(shared)) out.scopes[k] = 'classification';
      }
      // THE IDENTITY AND ITS LEX BOT: the bot's configuration names the alias it invokes, and the alias names
      // the conversation log group, so each is the assistant's own resource and not a guess.
      const botArn = placement.botArns?.[0];
      if (botArn) {
        out.botArn = botArn; own('botArn');
        if (clients.chimeIdentity) {
          try {
            const r = await clients.chimeIdentity.send(new DescribeAppInstanceBotCommand({ AppInstanceBotArn: botArn }));
            const alias = lexAliasOf(r.AppInstanceBot?.Configuration?.Lex?.LexBotAliasArn);
            if (alias) { out.lexBotId = alias.botId; out.lexBotAliasId = alias.aliasId; }
          } catch (err) { warn(`the identity of '${profileName}'`, err); }
        }
      }
      if (!out.lexBotId && placement.lexBotId) out.lexBotId = placement.lexBotId;
      if (out.lexBotId) own('lexBotId');
      if (out.lexBotId && out.lexBotAliasId) {
        own('lexBotAliasId');
        if (clients.lex) {
          try {
            const a = await clients.lex.send(new DescribeBotAliasCommand({ botId: out.lexBotId, botAliasId: out.lexBotAliasId }));
            const group = a.conversationLogSettings?.textLogSettings?.find((s) => s.enabled !== false)?.destination?.cloudWatch?.cloudWatchLogGroupArn;
            // `arn:aws:logs:{region}:{account}:log-group:{name}[:*]`
            const name = group?.split(':log-group:')[1]?.replace(/:\*$/, '');
            if (name) { out.lexLogGroup = name; out.scopes.lexLogGroup = 'classification'; }
          } catch (err) { warn(`the Lex alias of '${profileName}'`, err); }
        }
      }
      const dep = await deploymentLevel();
      Object.assign(out, dep);
      for (const k of Object.keys(dep)) out.scopes[k] = 'deployment';
    } catch (err) {
      warn(`infra for '${profileName}'`, err);
    }
    return out;
  };
}

/** One assistant, without a shared memo. */
export async function resolveProfileInfra(
  clients: InfraClients,
  opts: InfraOptions,
  profileName: string,
  placement?: InfraPlacement,
): Promise<ResolvedInfra> {
  return createInfraResolver(clients, opts)(profileName, placement);
}
