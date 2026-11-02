/**
 * ONLY THE OWNERSHIP FUNCTION CAN WRITE `owner-team` (SPEC-ADMIN-CONSOLE FR47, acceptance criterion (i)).
 *
 * The tag decides which assistants a team member's console reaches, so it is an ownership record only
 * while nobody it scopes can write it. Every `chime:TagResource` and `chime:UntagResource` grant in the
 * deployment therefore carries `ForAllValues:StringNotEquals aws:TagKeys owner-team`, except the one
 * statement the ownership function holds, which may write that key and no other.
 *
 * Read from the synthesized app rather than the stack sources, because a grant is a statement in a
 * template whichever helper built it, and a helper that forgot the condition is exactly the case.
 * Synthesized with the premium ops assistant declared (`ops-premium` in `profiles`) and in Aurora mode, so the role assistants' provisioners and
 * the Aurora stacks are in the set; the deny-test proves the same on the deployed policies.
 */
import * as path from 'path';
import { SYNTH_CAPABILITIES, synthesizeVariant, type Templates } from '../lib/docs/api-contract';

type Template = Templates[string];

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

type Statement = { Sid?: string; Effect?: string; Action?: unknown; Condition?: Record<string, Record<string, unknown>> };

/** Every policy statement in a template, with where it came from. */
function statementsOf(templates: Templates): Array<{ where: string; s: Statement }> {
  const out: Array<{ where: string; s: Statement }> = [];
  for (const [stack, t] of Object.entries(templates)) {
    for (const [id, r] of Object.entries(t.Resources ?? {})) {
      const docs: unknown[] = [];
      const p = r.Properties ?? {};
      if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') docs.push(p.PolicyDocument);
      if (r.Type === 'AWS::IAM::Role') {
        for (const inline of (p.Policies as Array<{ PolicyDocument?: unknown }> | undefined) ?? []) docs.push(inline.PolicyDocument);
      }
      for (const d of docs) {
        for (const s of ((d as { Statement?: Statement[] } | undefined)?.Statement ?? [])) out.push({ where: `${stack}/${id}`, s });
      }
    }
  }
  return out;
}

const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]).map(String);
/**
 * Written independently of the aspect's matcher, so one mistake cannot hide in both: an action written
 * with a wildcard is expanded against the two tag actions here by plain string rules.
 */
const TAG_ACTIONS = ['chime:tagresource', 'chime:untagresource'];
const covers = (pattern: string, action: string): boolean => {
  // Each literal piece between wildcards must appear in order; '*' spans anything, '?' one character.
  const pieces = pattern.toLowerCase().split('*').map((p) => p.split('').map((ch) => (ch === '?' ? '.' : ch.replace(/[^a-z0-9]/, (x) => '\\' + x))).join(''));
  return new RegExp('^' + pieces.join('.*') + '$').test(action);
};
const writesTags = (s: Statement & { NotAction?: unknown }): boolean => {
  if (s.Effect !== 'Allow') return false;
  if (s.NotAction !== undefined) {
    const excluded = (Array.isArray(s.NotAction) ? s.NotAction : [s.NotAction]).map(String);
    return TAG_ACTIONS.some((t) => !excluded.some((p) => covers(p, t)));
  }
  return actionsOf(s).some((a) => TAG_ACTIONS.some((t) => covers(a, t)));
};
const excludesOwnerTeam = (s: Statement): boolean => {
  const keys = s.Condition?.['ForAllValues:StringNotEquals']?.['aws:TagKeys'];
  return (Array.isArray(keys) ? keys : [keys]).includes('owner-team');
};

let templates: Templates | null = null;
const synth = (): Templates => {
  if (!templates) {
    // Every built capability (the admin notification channel among them) and live drift are on, so their creators' tag grants are in the set too.
    templates = synthesizeVariant(REPO_ROOT, { id: 'aurora+roles+admin-channel+drift', context: { analyticsMode: 'aurora', profiles: ['basic', 'standard', 'premium', 'ops-premium'], capabilities: [...SYNTH_CAPABILITIES], enableLiveDrift: 'true' } });
  }
  return templates;
};

describe('the owner-team tag has one writer', () => {
  it('every other tag grant excludes the key', () => {
    const offenders = statementsOf(synth())
      .filter(({ s }) => writesTags(s) && s.Sid !== 'OwnerTeamTagOnly' && !excludesOwnerTeam(s))
      .map(({ where, s }) => `${where}: ${actionsOf(s).join(',')}`);
    expect(offenders).toEqual([]);
  }, SYNTH_TIMEOUT_MS);

  it('keeps every grant it rewrites, rather than passing by dropping one', () => {
    // The rewrite replaces policy documents. A rewrite that lost one would leave nothing to flag, so
    // the grants are counted where they are known to exist, the third-party provider's among them.
    const excluded = statementsOf(synth()).filter(({ s }) => writesTags(s) && excludesOwnerTeam(s));
    expect(excluded.length).toBeGreaterThanOrEqual(16);
    expect(excluded.some(({ where }) => /Messaging\/CustomMessagingResourcesCustomResourceProviderRole/.test(where))).toBe(true);
    // The provisioner's session role holds the one identity tag grant (ADR-048, amended 2026-10-24).
    expect(excluded.some(({ where }) => /Messaging\/RuntimeAssistantProvisionerRole/.test(where))).toBe(true);
  }, SYNTH_TIMEOUT_MS);

  it('leaves every reference resolvable inside its own template', () => {
    // A rewrite that resolved a document early turned a reference to another stack's resource into a
    // raw `Fn::GetAtt` CloudFormation then refused ("references undefined resource"), while synthesis
    // passed. So every Ref and GetAtt must name something its own template defines.
    const dangling: string[] = [];
    for (const [stack, t] of Object.entries(synth())) {
      const tt = t as Template & { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown> };
      const known = new Set([...Object.keys(tt.Resources ?? {}), ...Object.keys(tt.Parameters ?? {}), ...Object.keys(tt.Conditions ?? {})]);
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (!v || typeof v !== 'object') return;
        const o = v as Record<string, unknown>;
        if (typeof o.Ref === 'string' && !o.Ref.startsWith('AWS::') && !known.has(o.Ref)) dangling.push(`${stack}: Ref ${o.Ref}`);
        const ga = o['Fn::GetAtt'];
        if (Array.isArray(ga) && typeof ga[0] === 'string' && !known.has(ga[0])) dangling.push(`${stack}: GetAtt ${ga[0]}`);
        Object.values(o).forEach(walk);
      };
      walk(tt.Resources);
    }
    expect(dangling).toEqual([]);
  }, SYNTH_TIMEOUT_MS);

  it('the ownership function may write that key and no other', () => {
    const own = statementsOf(synth()).filter(({ s }) => s.Sid === 'OwnerTeamTagOnly');
    expect(own).toHaveLength(1);
    expect(own[0].s.Condition?.['ForAllValues:StringEquals']?.['aws:TagKeys']).toEqual(['owner-team']);
  }, SYNTH_TIMEOUT_MS);
});

/**
 * WHICH ASSISTANT A BOT IS has one writer too: the provisioner that stamps an identity at creation, on the console's
 * session or a stack's seed (ADR-048, amended 2026-10-23), one statement per classification.
 * `assistant` and `role` are what ownership, the team routes and the acting role key on, so a grant able
 * to rewrite them could move a bot into another assistant's scope. The list is written here, apart from
 * the aspect's own map, so a key dropped from one is caught by the other.
 */
describe('a bot\'s identity tags have one writer', () => {
  const excludes = (s: Statement, key: string): boolean => {
    const keys = s.Condition?.['ForAllValues:StringNotEquals']?.['aws:TagKeys'];
    return (Array.isArray(keys) ? keys : [keys]).includes(key);
  };

  // The runtime provisioner's create-time stamp (ADR-048), one statement per classification.
  const RUNTIME_STAMP = /^TagRuntimeAssistantIdentityAtCreate/;
  const isWriter = (s: Statement) => RUNTIME_STAMP.test(s.Sid ?? '');

  it.each(['assistant', 'role'])('every grant but the provisioners\' excludes %s', (key) => {
    const offenders = statementsOf(synth())
      .filter(({ s }) => writesTags(s) && !isWriter(s) && !excludes(s, key))
      .map(({ where, s }) => `${where}: ${s.Sid ?? '(no sid)'} ${actionsOf(s).join(',')}`);
    expect(offenders).toEqual([]);
  }, SYNTH_TIMEOUT_MS);

  it('the runtime stamp writes identity keys only onto a bot that is already runtime, in one classification', () => {
    const stamps = statementsOf(synth()).filter(({ s }) => RUNTIME_STAMP.test(s.Sid ?? ''));
    expect(stamps.length).toBeGreaterThan(0);
    for (const { s } of stamps) {
      const eq = s.Condition?.StringEquals ?? {};
      expect(eq['aws:ResourceTag/provisioner']).toBe('runtime');
      expect(typeof eq['aws:ResourceTag/classification']).toBe('string');
      expect(eq['aws:RequestTag/classification']).toBe(eq['aws:ResourceTag/classification']);
      expect(s.Condition?.['ForAllValues:StringEquals']?.['aws:TagKeys']).toEqual(['classification', 'assistant', 'role', 'provisioner']);
      expect(excludes(s, 'owner-team')).toBe(true);
      expect(excludes(s, 'assistant')).toBe(false);
    }
  }, SYNTH_TIMEOUT_MS);
});

/**
 * A BOT'S CLASSIFICATION CANNOT BE CHANGED BY A CREATOR. It cannot be excluded by key
 * the way `assistant` and `role` are, because channels take `classification` from every creator. And a
 * creator's grant must still reach a bot: `CreateChannel` with `Tags` checks `chime:TagResource` on the
 * bearer, and narrowing every grant to channels refused every creation on the deployment. So a tag grant
 * that reaches a bot must pin the bot's current classification to the one requested, which makes the
 * only write it allows a write of the value already there.
 */
describe('a creator can tag its bearer bot but never change its classification', () => {
  const PROVISIONER_SIDS = new Set(['CreateRuntimeAssistantIdentity']);
  /** A resource rendered to a string, with every intrinsic replaced by a placeholder. */
  const render = (r: unknown): string => {
    if (typeof r === 'string') return r;
    const join = (r as { 'Fn::Join'?: [string, unknown[]] })?.['Fn::Join'];
    if (join) return join[1].map(render).join(join[0]);
    return '{token}';
  };
  const resourcesOf = (s: Statement): string[] => {
    const r = (s as { Resource?: unknown }).Resource;
    return (Array.isArray(r) ? r : [r]).map(render);
  };
  /** Whether a resource pattern can match an AppInstanceBot ARN. */
  const reachesBots = (resource: string): boolean =>
    resource === '*' || /\/bot\//.test(resource) || /app-instance\/[^/]*\/\*$/.test(resource)
    || (/\{token\}\/\*$/.test(resource) && !/\/(channel|user)\/\*$/.test(resource));
  /**
   * NOT GRANTS, AND NAMED SO EACH STAYS A DECISION. A permissions boundary is a limit and an
   * `AssistantGrant-*` policy is a session policy the vend passes at assume-role time: each only narrows
   * the acting role. The Amazon Chime SDK custom-resource provider belongs to `cdk-amazon-chime-resources`,
   * holds `chime:*` to create the app instance, and runs only when CloudFormation deploys it; it is the
   * one residual writer, recorded rather than overridden, and is denied every bot action (`messaging-stack.ts`).
   */
  const NOT_A_RUNTIME_GRANT = [/\/AssistantBoundary/, /\/AssistantGrant/, /Messaging\/CustomMessagingResourcesCustomResourceProviderRole/];
  const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]) as string[];
  /** A statement whose permitted keys leave out `classification` cannot write it, wherever it points. */
  const cannotWriteClassification = (s: Statement): boolean => {
    const only = s.Condition?.['ForAllValues:StringEquals']?.['aws:TagKeys'];
    const not = s.Condition?.['ForAllValues:StringNotEquals']?.['aws:TagKeys'];
    return (only !== undefined && !list(only).includes('classification')) || list(not).includes('classification');
  };
  /** Whether a statement allows a bot's classification to be written only as the value it already has. */
  const keepsTheBotsClassification = (s: Statement): boolean => {
    const eq = s.Condition?.StringEquals ?? {};
    const requested = list(eq['aws:RequestTag/classification']);
    const current = list(eq['aws:ResourceTag/classification']);
    return requested.length === 1 && current.length === 1 && requested[0] === current[0];
  };

  it('no tag grant reaches a bot unless it keeps the bot\'s classification', () => {
    const offenders = statementsOf(synth())
      .filter(({ where, s }) => writesTags(s) && !PROVISIONER_SIDS.has(s.Sid ?? '')
        && !NOT_A_RUNTIME_GRANT.some((p) => p.test(where)) && !cannotWriteClassification(s) && !keepsTheBotsClassification(s))
      .flatMap(({ where, s }) => resourcesOf(s).filter(reachesBots).map((r) => `${where}: ${s.Sid ?? '(no sid)'} -> ${r}`));
    expect(offenders).toEqual([]);
  }, SYNTH_TIMEOUT_MS);

  /**
   * AND EVERY CREATOR STILL REACHES ITS BEARER, which is the half that broke the deployment when it was
   * missing: each creates with `Tags` while bearing its classification's bot or the service admin. A
   * creator that bears only the service admin holds no bot leg at all (step 33): it never creates as an
   * assistant.
   */
  it.each([
    // Step 39: one creator per conversational classification, each with the drift creators' grant.
    ['a classification\'s conversation creator', /Assistants-premium\/ConversationCreatorRole/, 'DriftStampOwnClassificationOnly', true, false],
    ['a classification\'s drift creator', /Assistants-standard\//, 'DriftStampOwnClassificationOnly', true, false],
    // Step 37: the briefing creates through the shared creator, as the service admin only.
    ['the proactive briefing', /Notification.*\/ProactiveBriefingRole/, 'DriftStampOwnClassificationOnly', true, false],
    ['the admin channel provisioner', /AdminServices\/ProvisionFn/, 'AdminChannelTagged', true, true],
  ])('%s can tag its bearer when it creates', (_who, where, sid, bearsTheAdmin, bearsTheBot) => {
    const mine = statementsOf(synth()).filter((x) => where.test(x.where) && writesTags(x.s));
    const bot = mine.filter(({ s }) => (s.Sid ?? '').startsWith(`${sid}OnBearerBotOfThatClassification`));
    expect(bot.length > 0).toBe(bearsTheBot);
    for (const { s } of bot) {
      expect(resourcesOf(s).some((r) => /\/bot\/\*$/.test(r))).toBe(true);
      expect(keepsTheBotsClassification(s)).toBe(true);
    }
    const channel = mine.find(({ s }) => s.Sid === sid);
    expect(channel).toBeDefined();
    const rs = resourcesOf(channel!.s);
    expect(rs.some((r) => /\/channel\/\*$/.test(r))).toBe(true);
    // THE CHANNEL LEG NAMES NO BEARER: the admin carries `classification=admin`, which its resource
    // condition would refuse, so the bearer is on a leg of its own that pins the requested value only.
    expect(rs.some((r) => /\/user\//.test(r))).toBe(false);
    const bearer = mine.find(({ s }) => s.Sid === `${sid}OnBearer`);
    expect(!!bearer && resourcesOf(bearer.s).some((r) => /\/user\/[^*]+$/.test(r) || r === '{token}')).toBe(bearsTheAdmin);
    if (bearer) {
      expect(resourcesOf(bearer.s).some((r) => /\/channel\/|\/user\/\*$/.test(r))).toBe(false);
      expect(JSON.stringify(bearer.s.Condition?.StringEquals?.['aws:RequestTag/classification'] ?? null)).not.toBe('null');
    }
  }, SYNTH_TIMEOUT_MS);
});
