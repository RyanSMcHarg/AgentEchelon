/**
 * THE PLATFORM INTENT TAXONOMY AND HOW A STORED PACK RESOLVES AGAINST IT, as pure data and pure functions.
 *
 * The intent definitions, the platform's default pack, the inheritance rule (`extends: 'default'`), what each platform
 * intent hands over and which platform intents a pack refuses. Imports nothing at runtime, so the console resolves a
 * version's pack with the same functions the router and the processor serve it with (`intent-pack.ts` re-exports
 * every name here, and is where a deployment's pack is read).
 */
import type { AnswerGuidance } from './intent-answer.js';
import type { TaskStateMachine } from './task-state-machines.js';

export type IntentDeliveryClass = 'DIRECT' | 'PLACEHOLDER_UPDATE' | 'TASK_MULTI_STEP';

/**
 * An output a turn of an intent hands over, beyond the reply itself (DESIGN-CAPABILITY-REFUSAL §4).
 *
 * It decides WHERE a refusal points a person, never WHETHER to refuse: absence from the pack decides
 * that. A classification declares what it `produces` (`DeploymentClassification.produces`), so a
 * refused intent that `needs` a document can name the classifications the person reaches that produce
 * one, without any router reading another classification's configuration.
 */
export const INTENT_NEEDS = ['document', 'image'] as const;
export type IntentNeed = (typeof INTENT_NEEDS)[number];

export interface IntentDef {
  /** Stable key — the classified intent value + INTENT_ROUTE_STRATEGY key (e.g. 'report_generation'). */
  key: string;
  /** One line the LLM classifier sees describing when this intent applies. */
  description: string;
  /**
   * ONE LINE A PERSON READS, saying what they get. The advertisement, not the classification rule.
   *
   * `description` is written for the CLASSIFIER and is the wrong voice to greet somebody in: it earns
   * its keep by separating this intent from its neighbors ("Exporting the whole roster as a table is
   * data_extraction, not this"), which is a sentence no person asked for. This is the other job, and
   * splitting them is what stops one being written as the other.
   *
   * ABSENT MEANS RECOGNIZED BUT NOT ADVERTISED, deliberately. An assistant that lists everything it can
   * classify introduces itself with a menu, and a narrow internal lookup does not belong in the first
   * thing somebody reads. Absence is the default so that advertising is a decision.
   *
   * VOICE: second person, one clause, what the person gets. Not how this intent differs from another.
   *   good: "ask for a figure like ARR or churn and I will give it with the period it covers"
   *   bad:  "single financial metric requests, as opposed to compiled reports"
   *
   * Bounded by `MAX_INTENT_SUMMARY`, and the number SHOWN is bounded separately
   * (`MAX_ADVERTISED_IN_INTRODUCTION`) - a bound on each line does not bound the list.
   *
   * LANGUAGE: authored by the team that owns the intent, in one language, like every other stored
   * string on a profile. A conversation held in another language reaches this through the same path as
   * the rest of the assistant's copy; this field does not solve translation and must not be read as
   * though it does (tenet D11).
   */
  summary?: string;
  /** Lowercase substrings for the no-LLM keyword classifier (a keyword-mode profile / LLM-classifier failure). */
  keywords: string[];
  /** How a turn of this intent is delivered. Domain intents are usually PLACEHOLDER_UPDATE
   *  (one generated reply, updated in place) or TASK_MULTI_STEP (a tracked multi-step task). */
  delivery: IntentDeliveryClass;
  /** Optional per-intent response shaping. Forwarded in the event to
   *  the processor (D2). Omitted ⇒ the processor's default budget. `maxTokens` is clamped to the
   *  per-classification's token limit and the reasoning-turn floor at resolve time. */
  maxTokens?: number;
  verbosity?: ResponseVerbosity;
  /**
   * HOW TO ANSWER A TURN OF THIS INTENT, in the assistant's own prompt.
   *
   * `description` is written for the CLASSIFIER and the answering model never sees it; this is the
   * other half, and until it existed an intent could say what it WAS and nothing about what to DO.
   * Rendered into the system prompt for a turn classified with this key, after the persona and before
   * the context sections, so it reads as guidance within the assistant's character rather than as a
   * competing voice.
   *
   * Bounded by `MAX_INTENT_INSTRUCTIONS`: it is per-turn prompt weight on the classified path, and an
   * unbounded field here is a latency and cost decision disguised as configuration.
   */
  instructions?: string;
  /**
   * The tool subset a turn of this intent may use, NARROWING the profile's allowlist.
   *
   * INTERSECTED, NEVER WIDENED (tenet D4: a selection never broadens what its boundary permits). The
   * profile's `tools` is the boundary; naming a tool here that the profile does not allow is refused at
   * the write path rather than quietly granted. Absent ⇒ the profile's full allowlist, which is the
   * previous behavior for every intent.
   *
   * The point is focus rather than access: a single-fact lookup that cannot reach the report-writing
   * tools answers in one turn instead of being tempted into a multi-step detour.
   */
  tools?: string[];
  /**
   * The output a turn of this intent hands over beyond the reply (`IntentNeed`). Absent means the reply
   * is the whole answer. Read only to say where a refused request would be served.
   */
  needs?: IntentNeed;
  /**
   * PRESCRIPTIVE GUIDANCE for how this intent's answer is produced and delivered: temperature, message
   * or file, required sections and shape checks (`intent-answer.ts`; SPEC-CONFIGURABLE-INTENT-PACK
   * FR19-FR21). Absent behaves exactly as before.
   */
  answer?: AnswerGuidance;
}

export type ResponseVerbosity = 'tight' | 'normal' | 'long';

/** Per-intent response shaping resolved for a classified intent (forwarded in the event, D2). */
export interface ResponseSettings {
  maxTokens?: number;
  verbosity?: ResponseVerbosity;
}

export interface IntentPack {
  /** Domain intents only — the universal three are added implicitly. */
  intents: IntentDef[];
  /**
   * Task state machines keyed by taskType (SPEC-TASK-STATE-TRANSITIONS §4). Optional and
   * per-deployment: absent ⇒ the platform DEFAULT_TASK_STATE_MACHINES. A deployment may override
   * a subset; the accessor (`taskStateMachines`) merges its overrides over the defaults so the
   * work-item types (place_item, action_item) survive a pack that only tunes the domain machines.
   */
  machines?: Record<string, TaskStateMachine>;
}

/**
 * DEFAULT pack — the historical enterprise taxonomy. Keeping it as the default makes the pack
 * refactor a no-op for any deployment that doesn't set `ASSISTANT_INTENT_PACK` (back-compat
 * invariant, covered by intent-pack.test.ts).
 */
export const DEFAULT_INTENT_PACK: IntentPack = {
  intents: [
    // QUESTIONS ABOUT THE PLATFORM ITSELF. Every welcome invites them and every
    // assistant had the tool, yet no intent named them, so they were `general`: uncounted, unroutable,
    // and judged against an offer list that did not mention them. A pack declares it to offer it, with
    // instructions for how deep to go; a pack that does not declare it refuses it.
    // MINIMAL BY BUDGET: every byte here is stored again in each classification's parameter. A pack that
    // declares it supplies its summary, depth and tool (demo/intent-packs.ts); with no tool list the turn
    // keeps every tool, platform information included.
    {
      key: 'platform_question',
      description: 'About the AgentEchelon platform itself, not the company.',
      keywords: ['agentechelon'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions: 'Answer from platform information.',
    },
    {
      key: 'guided_troubleshooting',
      description:
        'User needs help diagnosing or fixing a problem, error resolution, step-by-step debugging, system issues',
      keywords: [
        'error', 'broken', 'not working', 'issue', 'problem', 'bug',
        'fix', 'troubleshoot', 'debug', 'crash', 'fail', 'help me with',
      ],
      delivery: 'TASK_MULTI_STEP',
      instructions:
        'Work one step at a time. Give the single next thing to check or try, say what result to look for, '
        + 'and wait for the result before the next step. Do not list every possible cause at once.',
      answer: { temperature: 0.2, form: 'message' },
    },
    {
      key: 'data_extraction',
      // Reserve this for STRUCTURED / BULK extraction that is genuinely multi-step work (a table, list,
      // spreadsheet, or dataset). A request for a SINGLE fact or figure the assistant can state in a
      // sentence ("what was our Q2 ARR?") is GENERAL, answered inline — routing it to a TASK_MULTI_STEP
      // defers the answer behind a task instead of just stating it (the premium-ARR failure mode). See
      // docs/design/decisions/018-company-context-tool-and-extraction-boundary.md.
      description:
        'User wants to extract or export MULTIPLE records or STRUCTURED data — a table, list, spreadsheet, ' +
        'or dataset — from sources, databases, APIs, or documents (e.g. "extract the churn-risk accounts as a ' +
        'table", "export the roster"). A request for a SINGLE fact or figure that can be answered in a ' +
        'sentence (e.g. "what was our Q2 ARR?") is GENERAL, not data_extraction.',
      keywords: [
        'extract', 'export data', 'as a table', 'as a spreadsheet', 'as a csv',
        'list all', 'pull the', 'data from', 'dataset',
        // Bulk-retrieval verbs scoped with "the" so they match "retrieve the logs" / "fetch the
        // records" (structured/bulk) but NOT a single-fact question ("what was our Q2 ARR?"), keeping
        // the ADR-018 boundary (docs/design/decisions/018-company-context-tool-and-extraction-boundary.md).
        'query the', 'fetch the', 'retrieve the',
      ],
      delivery: 'TASK_MULTI_STEP',
      instructions:
        'Lead with the extracted values as a table. Copy values verbatim from the source; never round, '
        + 'infer or fill a gap. Mark a value the source does not contain as not found.',
      answer: { temperature: 0, require: ['no-file-claim'] },
    },
    {
      // Image generation as a NORMAL capability + intent (DESIGN-MULTI-ASSISTANT-TURN-ENGINE,
      // "image generation must become a normal capability"): an assistant whose profile grants an
      // image model produces an IMAGE on a request that asks for one — in a battle or not. Declared
      // BEFORE report_generation so its keywords WIN for an image ask: "generate an image" contains
      // report_generation's 'generate', and classifyByPackKeywords returns the first-listed match.
      // A MULTI-STEP TASK (ADR-064 decision G): gather, confirm, generate on the image model, revise.
      key: 'image_generation',
      description:
        // A request that does not yet say what to draw is this intent too: the task's `gather` step asks for it.
        'User wants the assistant to GENERATE, create, draw or produce a new IMAGE / picture / illustration / ' +
        'logo (e.g. "draw a robot", "I need a picture for my slides"), even one that does not yet say what it ' +
        'shows. NOT a request to analyze or describe an existing image.',
      keywords: [
        'generate an image', 'create an image', 'make an image', 'draw ',
        'generate a picture', 'make a picture', 'an image of', 'picture of', 'image of a',
      ],
      delivery: 'TASK_MULTI_STEP',
      instructions:
        'Describe the image you are producing in one or two sentences. The image itself is delivered by '
        + 'the platform; do not describe a file.',
    },
    {
      // Code generation is its own intent, not a flavour of report_generation. It has a dedicated
      // RouteKey in the model strategy (and the admin Experiments tab offers it), which is only
      // reachable if the classifier can actually emit it — `IntentDef.key` doubles as the
      // INTENT_ROUTE_STRATEGY key. Without this entry a deployment could pin a code-specialist
      // model and never have it selected.
      //
      // Declared BEFORE report_generation for the same reason image_generation is: "generate a
      // TypeScript function" contains report_generation's very broad 'generate', and
      // classifyByPackKeywords returns the FIRST-listed match.
      //
      // delivery PLACEHOLDER_UPDATE, deliberately not TASK_MULTI_STEP: a code request has a direct
      // answer, and deferring it behind a tracked task is the ADR-018 failure mode (the user waits
      // on a task for something the assistant could simply have written).
      key: 'code_generation',
      description:
        'User wants a short piece of code answered in the conversation — one function, class, query, ' +
        'snippet, or a small change to code they supplied (e.g. "write a function that reverses a ' +
        'string"). A complete program, module or multi-file ' +
        'deliverable is code_delivery. Diagnosing a failure is guided_troubleshooting.',
      // Deliberately few. The classifier is the LLM — it reads `description`; these run only when
      // the LLM classifier is unavailable or a profile opts into keyword mode. A long keyword list
      // buys nothing on the shipped path and costs real bytes against the SSM Standard-tier
      // parameter limit (4096 chars) that the seeded per-deployment packs live inside.
      keywords: ['write a function', 'write code', 'implement a', 'unit test', 'refactor this'],
      delivery: 'PLACEHOLDER_UPDATE',
      summary: 'Write a short piece of code',
      instructions:
        'State the language and any assumption in one line, give the code in one fenced block with the '
        + 'language named, then a short note on how to use it. Keep it to what was asked.',
      answer: { temperature: 0.2, form: 'message', require: ['code-block'] },
    },
    {
      // The review counterpart. Separate from code_generation because the useful model for critique
      // is not always the useful model for authoring, which is exactly what a per-intent route is
      // for. Also declared before report_generation ('review' co-occurs with 'summary'/'analysis').
      key: 'code_review',
      description:
        'User wants the assistant to REVIEW, critique, or assess existing code they have supplied — ' +
        'correctness, style, security, or performance (e.g. "review this pull request", "is this ' +
        'function correct?", "what is wrong with this code?"). Writing new code is code_generation; ' +
        'diagnosing a runtime failure is guided_troubleshooting.',
      keywords: ['code review', 'review this code', 'review my code', 'critique this code'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'List findings ranked by severity. For each: where it is, what is wrong, and the fix as a short '
        + 'code change. End with what is good about the code, briefly.',
      answer: { temperature: 0.2, form: 'message', sections: ['Findings', 'What is good'], require: ['sections'] },
    },
    {
      // The last RouteKey without an intent. Like the code intents, `strategic_analysis` is a route
      // in the model strategy and a selectable option in the admin Experiments tab, so leaving it
      // unclassifiable made it dead config.
      //
      // KEYWORDS ARE DELIBERATELY NARROW. report_generation already owns the bare word 'analysis',
      // and the existing suite sends "Analyze the pros and cons of microservices vs monolithic" -
      // which is a report_generation TASK_MULTI_STEP turn today. Claiming generic analysis phrasing
      // here would silently re-route those turns to a different delivery class, changing behavior
      // for every deployment that never asked for it. These keywords name STRATEGY work
      // specifically; broadening them is a deliberate product decision, not a naming tidy-up.
      key: 'strategic_analysis',
      description:
        'User wants strategic or business judgement — a competitive or market assessment, a business ' +
        'case, a go-to-market or roadmap decision, a build-vs-buy call (e.g. "what is our competitive ' +
        'position", "make the business case for X"). A factual write-up or formatted document is ' +
        'report_generation; a technical comparison is general.',
      keywords: ['strategic', 'competitive analysis', 'business case', 'go-to-market'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'Give the recommendation first, then the reasoning that supports it, then the risks and what '
        + 'would change the recommendation.',
      answer: { temperature: 0.5, form: 'auto', fileAbove: { chars: 8000 }, fileType: 'markdown', sections: ['Recommendation', 'Reasoning', 'Risks'], require: ['sections'] },
    },
    {
      // THE CODE DELIVERABLE, as a task. A complete program or module is agreed before it is written
      // (language, behavior, where it runs) and delivered as a file named by its language, which a
      // snippet in the message cannot be. Its machine is `code_delivery` in task-state-machines.ts.
      key: 'code_delivery',
      summary: 'Build and deliver a complete code file',
      description:
        'User wants a complete program, module, script or multi-part code deliverable built for them '
        + '(e.g. "build me a CLI tool that syncs these two folders", "write the full service for this", '
        + '"give me the complete script as a file"). A short function or snippet is code_generation.',
      keywords: ['complete script', 'full module', 'whole program', 'code file', 'build me a'],
      delivery: 'TASK_MULTI_STEP',
      instructions:
        'Agree what is needed before writing: the language and runtime, what it must do, and where it '
        + 'runs. Then write the complete code in one fenced block with the language named.',
      answer: { temperature: 0.2, fileType: 'code', require: ['code-block', 'no-file-claim'] },
    },
    {
      // A DESIGN DOCUMENT, as a task: the requirements and an outline are agreed, then the document is
      // written and delivered. Its machine is `technical_design` in task-state-machines.ts.
      key: 'technical_design',
      summary: 'Write a technical or solution design',
      description:
        'User wants a technical, system or solution DESIGN produced - architecture, components, data '
        + 'flow, interfaces and trade-offs for something to be built (e.g. "design the architecture for '
        + 'X", "write a technical design for this feature"). Reviewing an existing design is design_review.',
      keywords: ['technical design', 'system design', 'design document', 'architecture for'],
      delivery: 'TASK_MULTI_STEP',
      instructions:
        'Agree the goal, the constraints and the audience, then an outline, before writing. The design '
        + 'covers the problem, the proposed design, the alternatives considered and the risks.',
      answer: {
        temperature: 0.3,
        sections: ['Problem', 'Proposed design', 'Alternatives', 'Risks'],
        require: ['sections', 'no-file-claim'],
      },
    },
    {
      key: 'design_review',
      summary: 'Review a design',
      description:
        'User wants an existing design, architecture or proposal REVIEWED - gaps, risks, trade-offs '
        + '(e.g. "review this architecture", "what is wrong with this design?"). Producing a new design '
        + 'is technical_design; reviewing code is code_review.',
      keywords: ['review this design', 'design review', 'review the architecture'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'List the findings ranked by impact, each with the risk it creates and a concrete change. End '
        + 'with what the design gets right, briefly.',
      answer: { temperature: 0.3, form: 'message', sections: ['Findings', 'What works'], require: ['sections'] },
    },
    {
      key: 'report_generation',
      description:
        'User wants to create a report, summary, analysis document, dashboard data, or formatted output',
      keywords: [
        'report', 'generate', 'summary', 'analysis', 'dashboard',
        'create a report', 'compile', 'document', 'format',
      ],
      delivery: 'TASK_MULTI_STEP',
      instructions:
        'Write the report for the audience and length the person agreed.',
      answer: { temperature: 0.4, require: ['no-file-claim'] },
    },
  ],
};

/**
 * A pack AS AUTHORED AND STORED, which is not the same shape as a pack in use.
 *
 * `extends: 'default'` carries only what this deployment or profile ADDS and inherits the platform
 * taxonomy for the rest. Opt-in, so a pack without it REPLACES exactly as before: that is what lets a
 * deployment drop a default intent it does not want, and changing it silently would take that away.
 *
 * Why the stored form has to stay this shape rather than being resolved once at the write: a pack lives
 * inside ONE SSM parameter capped at 4096 characters, shared with the rest of the profile
 * definition. Copying the platform defaults in spends 3183 of those before anything of its own is said,
 * and measured on this deployment the three resolved definitions come to 4422, 4746 and 5256 characters
 * - every one of them over the limit, where the authored form needs 1260, 1584 and 2094. Resolving
 * before storing would not fit, so `resolveStoredPack` resolves at READ time instead.
 */
/**
 * One entry as STORED: a key, plus only the fields this pack chooses to say.
 *
 * A key that names an INHERITED platform intent is a PARTIAL OVERRIDE - the declared fields are merged
 * over the inherited one and everything else is kept. That is what makes a platform intent editable at
 * all inside a 4096-character parameter: restating `report_generation` in full to change one line of
 * its instructions costs most of the budget, and the platform intents together cost 3183 characters
 * against a premium pack that already spends 2411 on its own.
 *
 * A key that names no inherited intent is a NEW intent and must carry `description`, `keywords` and
 * `delivery` itself, which the write path enforces.
 */
export type StoredIntentDef = Partial<IntentDef> & { key: string };

export interface StoredIntentPack {
  /** Inherit the platform taxonomy for every key this pack does not itself declare. */
  extends?: 'default';
  /** What this pack declares of its own, whole intents and partial overrides alike. */
  intents: StoredIntentDef[];
  machines?: Record<string, TaskStateMachine>;
}

/**
 * Merge declared intents over the platform defaults. ONE implementation, shared by the raw-JSON read
 * path and the stored-object read path, because two copies of an inheritance rule drift and the drift
 * is invisible: it shows up as a classifier that recognizes a different taxonomy than the console shows.
 *
 * Own intents come FIRST, then any default whose key was not overridden - the same order the seeder
 * used when it inlined them, so the classifier prompt is unchanged for a migrated pack.
 */
export function applyExtends(declared: StoredIntentDef[], extendsDefault: boolean): IntentDef[] {
  const byKey = new Map(DEFAULT_INTENT_PACK.intents.map((d) => [d.key, d]));
  const own = declared.map((d) => {
    const inherited = extendsDefault ? byKey.get(d.key) : undefined;
    // PARTIAL OVERRIDE: the declared fields win, the inherited ones fill the rest. Without this an
    // operator editing one line of a platform intent silently reset every field they did not restate -
    // most damagingly `delivery`, which decides whether the turn opens a tracked task at all.
    if (inherited) return { ...inherited, ...d } as IntentDef;
    // A standalone intent supplies its own everything; the write path refuses it otherwise, and the
    // read path still fills platform defaults rather than dropping the turn's taxonomy.
    return {
      delivery: 'PLACEHOLDER_UPDATE' as IntentDeliveryClass,
      description: '',
      keywords: [],
      ...d,
    } as IntentDef;
  });
  const resolved = extendsDefault
    ? [...own, ...DEFAULT_INTENT_PACK.intents.filter((d) => !own.some((o) => o.key === d.key))]
    : own;
  return resolved;
}

/**
 * Resolve a pack stored on a profile version into the pack a reader uses. Pure, and the counterpart of
 * `parseIntentPack` for a pack that arrives already parsed (off a definition) rather than as raw JSON.
 *
 * NO FALLBACK TO DEFAULT HERE. `parseIntentPack` guards a raw string that may be corrupt; this takes a
 * value the write path already validated with `validateIntentPackBody`, so swallowing a problem would
 * hide a stored-shape bug rather than survive an operator's typo.
 */
export function resolveStoredPack(stored: StoredIntentPack): IntentPack {
  const intents = applyExtends(stored.intents, stored.extends === 'default');
  return stored.machines ? { intents, machines: stored.machines } : { intents };
}

/**
 * WHAT EACH PLATFORM INTENT HANDS OVER beyond its reply (`IntentDef.needs`), kept beside the taxonomy
 * rather than inside it.
 *
 * THE BYTES ARE THE REASON. `DEFAULT_INTENT_PACK` is copied into every classification's 4096-character
 * SSM parameter, and its size budget (`intent-pack.test.ts`) leaves a deployment room for its own
 * intents. A platform fact that no pack needs to restate does not belong in every copy. A custom intent
 * declares its own `needs`; a platform intent's is read from here, whichever pack carries it.
 */
export const PLATFORM_INTENT_NEEDS: Readonly<Record<string, IntentNeed>> = {
  report_generation: 'document',
  data_extraction: 'document',
  image_generation: 'image',
};

/** What a turn of this intent hands over: its own declaration, else the platform's. */
export function needsOf(def: Pick<IntentDef, 'key' | 'needs'>): IntentNeed | undefined {
  return def.needs ?? PLATFORM_INTENT_NEEDS[def.key];
}

/**
 * THE PLATFORM INTENTS THIS ASSISTANT DOES NOT OFFER, which a turn is refused for (DESIGN-CAPABILITY-
 * REFUSAL §3: "non-existence should trigger refusal").
 *
 * Every intent of the platform taxonomy the served pack does not declare. Nothing has to be listed to
 * be refused, and nothing a pack declares is refused: declaring an intent is how an assistant offers
 * it. A pack that inherits the platform taxonomy (`extends: 'default'`) declares every platform intent,
 * so it refuses nothing, which keeps every such deployment exactly as it was.
 *
 * Returned with the PLATFORM definition, because recognizing the request needs the platform's
 * description - the served pack, by construction, has none for it.
 */
export function refusedPlatformIntents(served: { intents: ReadonlyArray<{ key: string }> }): IntentDef[] {
  const declared = new Set(served.intents.map((d) => d.key));
  return DEFAULT_INTENT_PACK.intents.filter((d) => !declared.has(d.key));
}

/** One intent of a served pack as the assistant page shows it (`ClassificationCatalog.intents`, and a version's own pack). */
export interface CatalogIntent {
  key: string;
  description: string;
  summary?: string;
  instructions?: string;
  /** True when a turn of this intent opens a task (`delivery: TASK_MULTI_STEP`). */
  multiStep: boolean;
  /** The machine that task runs: the intent's own key, present only when the machines declare it. */
  machine?: string;
  /** What a turn of this intent hands over (`needsOf`): `image` makes the card offer an image model. */
  needs?: string;
  /** The tools a turn of this intent is offered (`toolsForIntent`): the version's allowlist narrowed to these. Absent means all of it. */
  tools?: string[];
}

/** One intent of a served pack as the assistant page shows it, its machine read from the machines that run it. */
export function catalogIntentOf(i: IntentDef, machines: Readonly<Record<string, unknown>>): CatalogIntent {
  const multiStep = i.delivery === 'TASK_MULTI_STEP';
  const needs = needsOf(i);
  return {
    key: i.key,
    description: i.description,
    ...(i.summary ? { summary: i.summary } : {}),
    ...(i.instructions ? { instructions: i.instructions } : {}),
    multiStep,
    ...(multiStep && machines[i.key] ? { machine: i.key } : {}),
    ...(needs ? { needs } : {}),
    ...(i.tools ? { tools: [...i.tools] } : {}),
  };
}
