# SPEC: Document templates

**Status:** Partial (the template format, storage behind an active-version pointer, the workflow declaration and the choice, the rendered guidance, the structural check, the recording and the platform fill, a tool-result binding included, ship, and so does the platform's `report` template, which the platform report workflow declares and the deploy writes for each classification serving it; the manager's console and a live run of FR10 do not). The same format and store also hold message and prompt templates, in an owner family per assistant beside the classification's ([ADR-062](../../../design/decisions/062-a-message-is-a-template-stored-and-versioned-like-a-document.md), slice 1); a workflow's document reference loads only a document. **Verified by:** `backend/test/lib/a-template-is-parsed-to-its-structure.test.ts` (the parser's outline and its refusals, and the guidance rendered from it), `backend/test/lib/a-template-is-a-stored-version.test.ts` (content-addressed bodies, activation and rollback re-pointing only, the reader's key and hash checks, a missing reference named), `backend/test/a-classification-reads-only-its-own-templates.test.ts` (the synthesized grants and the deploy-time writer: a classification serving a templated workflow receives the shipped template create-only from a writer that reaches only that template's names, a classification with no templated workflow has no writer, and every classification's roles read only its own prefix and pointers), `backend/test/lib/an-assistants-own-template-is-said-first.test.ts` (the owner families, and a message template refused where a document is asked for), `backend/test/lib/a-delivering-step-declares-its-template.test.ts` (validation, the choice as an enum of the declared names, the recorded choice delivered, the guidance returned with an advance, and the platform report workflow's declaration), `backend/test/the-demo-report-offers-a-choice-of-templates.test.ts` (the demo's premium pack offers two templates on the report workflow's delivering states and changes nothing else), `backend/test/lib/a-pack-machine-keeps-its-flags.test.ts` (the pack coercion carries `template`, `templates` and `defaultTemplate`), `backend/test/lib/a-document-is-checked-against-its-template.test.ts` (the structural comparison, a translated document included), `backend/test/lib/a-delivery-records-its-template.test.ts` (the delivery records), `backend/test/lib/a-template-is-filled-by-the-platform.test.ts` (the deterministic fill and its refusal, a field bound to a recorded step-action result, and the template a replayed advance carries), `backend/test/lib/a-deliverable-is-checked-before-it-ships.test.ts` (a document that still misses its template is withheld from the file and posted after the reply), `backend/test/lib/a-deterministic-workflow-runs-in-the-turn.test.ts` (a workflow that runs an action and delivers its platform-filled template with no model call after its requirements).

**Coverage:** `tests/e2e/document-templates.spec.ts` - reads premium's report workflow from the deployment, names the non-default template where it offers a choice, drives the report to delivery, and compares the attached document to the version its delivery record names by position, heading level and table columns, with the record's name, content hash and choice checked; `tests/e2e/tasks.spec.ts` and `tests/e2e/report-flow-branches.spec.ts` make the same structural comparison on the reports they deliver and revise.

**Related:** [SPEC-TASK-STATE-TRANSITIONS.md](./SPEC-TASK-STATE-TRANSITIONS.md) - the workflow a template attaches to, and the declared document a delivering step hands over. [SPEC-CONFIGURABLE-INTENT-PACK.md](../assistants/SPEC-CONFIGURABLE-INTENT-PACK.md) - where a deployment declares its own workflows. [SPEC-PORTABLE-PROFILES.md](../assistants/SPEC-PORTABLE-PROFILES.md) - the content-addressed body store this reuses.

**Site section:** Interaction layer, conversation.

---

## Overview

**A workflow can fix a deliverable's format while the model writes its content.** The platform offers three levels of control, and a template is the middle one. An intent with no workflow is answered on the model's judgment. A workflow adds fixed steps: the requirements are put to the person, the work is validated, and only a declared step delivers. A template adds a fixed shape to what that step delivers: the sections, their order and the tables, so every report of one kind reads the same way whoever asked and whichever model wrote it. At the far end, a template the platform fills from recorded data delivers an entirely deterministic document with no model writing at all.

**A template is a classified artifact, not a prompt.** It lives in S3 under its classification's prefix, so the IAM split that governs every other classified artifact decides who reads it. A delivering step references it by name; the platform loads it into that step's guidance on every turn rather than leaving it to retrieval, and the delivery check compares the declared document's structure to the template's before anything is attached.

## Business Problem

A team that publishes the same kind of document repeatedly (a quarterly account review, an incident summary, a churn-risk extract) needs every copy to carry the same sections in the same order, because readers scan for them and downstream processes depend on them. Instructions in prose do not hold a format: the model varies headings, drops a section when it has little to say and adds ones nobody asked for, and an example placed in the knowledge base is reached only when retrieval happens to rank it. A declared template, loaded deterministically and checked structurally, makes the format a property of the workflow, so the deployment gets consistent documents while the model still decides what goes in them.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here.

### Manager

**How this relates to them:** they own a kind of document and decide what it must contain. They author or approve the template and choose which workflows use it.

| What they need | Requirement |
|---|---|
| Fix the sections, order and tables of a document kind once, and have every delivery follow it | FR1, FR3, FR5 |
| Offer people a choice of formats for one kind of work, and have the one they chose delivered | FR3, FR3a |
| Change the template without a deploy, and roll back to the previous version | FR2, FR7 |
| Know which version of the template a delivered document was written against | FR8 |
| Have a fully fixed document produced from recorded data when judgment adds nothing, the result of an action the workflow ran included | FR9 |

### End user

**How this relates to them:** they ask for the document. They never see the template; they see a document that reads like every other one of its kind.

| What they need | Requirement |
|---|---|
| Receive a document in the format their team expects, without having to describe it | FR3, FR5 |
| Pick from the formats on offer, and get the one they picked | FR3a |
| Not receive a document that silently dropped a required section | FR5, FR6 |
| Get a template-shaped document in their own language | FR5 |

### AI developer

**How this relates to them:** they wire templates into workflows and intent packs, and need the declaration to validate before it ships.

| What they need | Requirement |
|---|---|
| Reference a template from a delivering step, and have a missing or unreadable reference refused at load rather than at delivery | FR3, FR4 |
| Know exactly what the model was told and what the check compared | FR5, FR8 |

### Admin / operator

**How this relates to them:** they see whether deliveries follow their templates and where they do not.

| What they need | Requirement |
|---|---|
| See, per template and version, how many deliveries passed the structural check first time, after a correction, or not at all | FR8 |
| Manage templates per classification, with access bounded by that classification | FR2, FR7 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects**, using the same values as [SPEC-TASK-STATE-TRANSITIONS](./SPEC-TASK-STATE-TRANSITIONS.md).

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | A template is a Markdown document whose headings are its sections and whose tables declare their columns. A front-matter block names the template, marks optional sections, and declares the guidance for each section; guidance is instruction to the model and is never expected in the output | Table stakes | Yes | `a-template-is-parsed-to-its-structure` (unit, behavior) |
| FR2 | Templates are stored in S3 under `templates/<classification>/<name>/<contentHash>.md`, content-addressed and never overwritten, with an active-version pointer per name. Read access follows the classification prefix through the same resolver the context corpus uses; only the manage role writes (tenet D15) | Table stakes | Partly - stored, content-addressed and created once, behind a per-name pointer, and each classification's turn roles read only their own prefix and pointers, granted only where a workflow it serves declares a template; the writers are the operator's own credentials through `npm run template` and, for the shipped templates, the deploy-time writer scoped to its own classification's prefix and pointers, rather than a manage role, and the read is the template store's own, not the context corpus resolver | `a-template-is-a-stored-version` (unit, behavior), `a-classification-reads-only-its-own-templates` (unit, behavior); no live deny-test |
| FR3 | A delivering state declares `template: <name>` (optionally pinned to a version), or `templates: [<name>, ...]` with an optional `default`. The declaration rides the workflow wherever it is declared: the platform defaults, or a classification's intent pack | Differentiator | Yes | `a-pack-machine-keeps-its-flags` (unit, behavior), `a-delivering-step-declares-its-template` (unit, behavior) |
| FR3a | When a delivering state declares more than one template, the person chooses. The workflow's requirements step carries a `template` need whose value the tool schema restricts to the declared names, recorded with its source and evidence like every requirement; a presented step with no choice yet lists each template's name and description and asks. The delivering step loads the recorded choice, never one the model picks at delivery, and a revision keeps it unless the person asks for another, which records a new choice. With no choice and a declared `default`, the default is used and stated to the person as the requirement being taken | Differentiator | Yes | `a-delivering-step-declares-its-template` (unit, behavior) |
| FR4 | Workflow validation refuses a `template` on a state that does not deliver, and a reference to a template that does not exist for the classification, at load time | Table stakes | Partly - validation refuses a template on a state that does not deliver; existence is checked where the pack and the store are both read, by `npm run template -- check` and by every turn that loads the workflow, which refuses the delivering move with the reason. Deploy does not check it, because synth cannot read the store | `a-delivering-step-declares-its-template` (unit, behavior), `a-template-is-a-stored-version` (unit, behavior) |
| FR5 | When a turn is in, or advances into, a state that declares a template, the platform loads it and renders its structure and section guidance into the step's guidance, including the guidance returned with the advance. The model writes in the conversation's language; the check is structural, so a translated document passes | Differentiator | Yes | `a-delivering-step-declares-its-template` (unit, behavior), `a-template-is-parsed-to-its-structure` (unit, behavior) |
| FR6 | The delivery check compares the declared document to the template by structure: required sections present and in order (by position and heading level, not heading text), and each declared table present with its column count. A miss triggers the bounded correction with the missing structure named; a document that still fails posts inline rather than being attached. Heading-text agreement is recorded as a metric only (tenet D11) | Differentiator | Yes | `a-document-is-checked-against-its-template` (unit, behavior), `a-deliverable-is-checked-before-it-ships` (unit, behavior for the decision and the inline post; source text for the gate reading it) |
| FR7 | Activating a template version or rolling back changes what the next delivery uses with no deploy and no write to an existing body | Table stakes | Yes | `a-template-is-a-stored-version` (unit, behavior) |
| FR8 | Each delivery records the template name and content hash it was checked against, and the check result (passed, passed after correction, posted inline), on the task's delivery record and the turn's analytics record | Table stakes | Yes - recorded on the task delivery, the turn's analytics record (`documentTemplate`) and the delivered-document reference; `template_outcomes` (`getTemplateOutcomes` in `analytics-query.ts`) reads it per assistant, classification and template, counting first-time passes, passes after a correction, inline posts and platform fills with the template versions a row spans, and the Effectiveness tab shows it as **Document templates** | `a-delivery-records-its-template` (unit, behavior for the reference, source text for the three writes), `housekeeping-readers-and-removals` (unit, behavior), `TemplateOutcomesPanel` (unit, behavior) |
| FR9 | A template may declare `fill: platform`, with fields bound to recorded data (the task's sourced requirements, a tool result); the platform renders the document with no model call, and an unbound field refuses the delivery rather than shipping a gap | Above bar - optional | Yes | `a-template-is-filled-by-the-platform` (unit, behavior), `a-deterministic-workflow-runs-in-the-turn` (unit, behavior) |
| FR10 | A live deployment delivers a templated report whose sections match the template | Table stakes | Partly - every report follows a template (the platform report workflow declares `report`, and the demo's premium pack offers a choice), and the e2e runs as the optional `document-templates` validate phase; **NOT VERIFIED** on a deployment | `document-templates` (e2e, behavior) |

**Acceptance criteria.** A report workflow whose delivering step declares a template delivers documents whose required sections appear in the template's order on every run, including when the conversation is in a second language. Removing a required section from the model's draft produces a correction naming it, and a draft that still lacks it is posted inline, not attached. Activating a new template version changes the next delivery without a deploy, and the delivery record names the version used.

**How it is built.** The format, the declaration fields and the operator commands are in [HOW-TO-ADD-OR-MANAGE-A-PROFILE](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md#document-templates). A template's front matter is a JSON object between two `---` lines. Bodies are stored at `templates/<classification>/<name>/<sha256>.md` in the attachments bucket with a create-only write, and the active version is the SSM parameter `<ssmRoot>/assistant/<classification>/templates/<name>`, holding the active hash and the earlier ones a rollback returns to. The processor loads the templates a task's workflow declares before the turn runs, caching a body for the container's life by its hash and a pointer for 30 seconds (`lambda/src/lib/template-store.ts`). The platform's own templates are Markdown files in `lib/config/default-templates/`; `lib/config/default-templates.ts` parses them and derives at synth which a classification's workflows declare (`templatesDeclaredFor`: the intents it serves, less a document-producing one where the registry's `produces` holds no `document`, each selecting its workflow), and `lib/constructs/default-template-writer.ts` writes each one for that classification at deploy, the body with `If-None-Match: *` and the pointer with `Overwrite: false`, so a version the deployment activated is never moved by a redeploy. A classification with no templated workflow gets no writer and no templates read grant. The parser, the guidance, the structural check and the fill are `lambda/src/lib/document-template.ts`, and a field's binding is read by `lambda/src/lib/step-bindings.ts`, the reader a step action's arguments use too, so `tool:<state>.<path>` reads the result the action on `<state>` recorded at `details.actions[<state>]` ([SPEC-TASK-STATE-TRANSITIONS](./SPEC-TASK-STATE-TRANSITIONS.md) FR29); the declaration and its validation are `task-state-machines.ts`; the choice and the refusals are `task-tools.ts`; the check and the recording run in the delivery gate of `assistant-async-processor.ts`.

**Known limits on the delivered rows.** The manager's console for document templates ("The manager" below) is **NOT BUILT**, so document templates are put, activated and rolled back with `npm run template`, on the operator's own credentials. The deployed principals that write to the template store are the deploy-time writer of the shipped document templates and the console's message-template writer (`manage-message-templates.ts`), which reaches only an assistant's own family, `templates/<classification>/_assistants/<assistant>/`; no turn role writes one. Synth sees a classification's deploy-time pack and the platform pack, not a pack that rides a profile version or is seeded after the deploy, so a template only such a pack declares is put with `npm run template`. The templates a turn loads are its own task's, so a delivering move on a task the model redirected to mid-turn is refused with `template_unavailable` when that task's workflow declares a template: the turn holds no template of that workflow to check the document against, and the refusal is the honest outcome rather than an unchecked delivery. The model reads it and the redirected task delivers on its own next turn. A retried model call that replays an advance already written carries the template with its document (`declarationForReplayedAdvance`), re-rendering a platform-filled one from the record. The structural check reads ATX headings (`#` to `######`) and pipe tables; a setext heading or an HTML table is not a section or a table to it. The demo's premium pack redeclares the report workflow with a choice of `quarterly-account-review` (the default) and `executive-summary`, both stored by the demo seed; every other demo classification that serves the workflow delivers in the platform's `report` template.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Rich formats (DOCX, PDF, slides) and visual styling | The deliverable is Markdown today; rendering to other formats is a separate output concern | not specified |
| Choosing a template from retrieval or similarity | A template is a declared format, and retrieval is optional and ranked; that is the unreliability this replaces | this spec, FR3 and FR5 |
| Per-person templates | A template is a team's format, owned per classification | not specified |
| Templates for chat replies | A reply's form is the intent's `answer` declaration | [SPEC-CONFIGURABLE-INTENT-PACK.md](../assistants/SPEC-CONFIGURABLE-INTENT-PACK.md) |
| Moving the classification intent pack into the body store | A separate prerequisite for large manager-declared workflows; templates live in S3 already and do not depend on it | Not specified |

## User Experience Description and Mocks

### The end user

They ask for "the quarterly account review for Coastal Health". The requirements step states what it is taking and they confirm. Where the workflow offers several formats and they named none, the same step lists them ("a full quarterly review, or a one-page summary?") and records the one they pick. The delivered file opens with the same sections every account review has, in the same order, and nothing in it addresses them; anything the assistant wants to say is in the chat message beside the file.

### The manager

Each template's deliveries are read on the Effectiveness tab's **Document templates** panel: per template, how many passed the structural check first time, after a correction, were posted inline, or were filled by the platform. **NOT BUILT:** a Templates section under each classification that lists its document templates with their active version and the workflows that reference each, uploads a new version as a Markdown file, previews the section outline the platform parsed from it, activates it, and rolls back to the previous version.

```
Templates - premium
┌───────────────────────────┬─────────┬─────────────────────────────┬───────────┐
│ Template                  │ Active  │ Used by                     │ First-time│
├───────────────────────────┼─────────┼─────────────────────────────┼───────────┤
│ quarterly-account-review  │ 3f9a…   │ report_generation.generating │ 92%       │
│ churn-risk-extract        │ 81c2…   │ data_extraction.formatting   │ 100%      │
└───────────────────────────┴─────────┴─────────────────────────────┴───────────┘
```

### The AI developer

They add `template: quarterly-account-review` to the delivering state of a workflow in the classification's intent pack. Loading the pack refuses the declaration on a state that does not deliver. A template that does not exist for the classification is named by `npm run template -- check`, and a turn that reaches the delivering step refuses the move with the reason instead of delivering an unshaped document.

## Related Documents

- [SPEC-TASK-STATE-TRANSITIONS.md](./SPEC-TASK-STATE-TRANSITIONS.md) - workflows, the declared document, and the delivery check this extends
- [SPEC-CONFIGURABLE-INTENT-PACK.md](../assistants/SPEC-CONFIGURABLE-INTENT-PACK.md) - deployment-declared workflows
- [SPEC-PORTABLE-PROFILES.md](../assistants/SPEC-PORTABLE-PROFILES.md) - the content-addressed body store and activation model this reuses
- A design doc follows once the spec is accepted.
