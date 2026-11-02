---
description: "Review docs as team members to find inconsistencies and recommend updates (usage: /doc-review [file] [--as role1,role2]) Roles: product, principal, developer, designer, ux, appsec, legal, qa, pm"
---

Perform a documentation review with the following parameters: $ARGUMENTS

## Four checks that come before the role perspectives

Every review runs these first, in this order, whatever `--as` roles are selected. They are not a role's opinion; they are the bar the document has to clear.

1. **Project tenets.** Read [`../../docs/overview/TENETS.md`](../../docs/overview/TENETS.md) and check adherence rather than assuming it. Where a tenet settles a question the document raises, name the tenet.
2. **Project style.** No em-dashes (use " - "). American English. Present tense describing the as-built state, with no past-state narration and no dated status blocks. Not hard-wrapped: one line per paragraph. No first person, no chat asides. Anything unbuilt is bold **NOT BUILT** / **ROADMAP** / **OPEN**. A `Status: Implemented` claim requires cited code plus a named `Verified by:` test.
3. **What is unique about this project, including the security posture - considered FIRST, before any generic feature description.** Classification as the IAM-evaluated axis, bearer pinning, permissions boundaries as limits, isolation proven by deny-test rather than by review, and the three-store split with one source per question. A document that would read the same for any AI platform has missed the point of this one, and that is a finding.
4. **Does the feature meet or exceed the industry bar?** Assess it, and check that the answer is recorded in the right place, because it splits:
   - **The public document carries only the consequence**, as a keep-or-cut `Priority` column on the Functional Requirements table: `Table stakes`, `Differentiator`, `Gap - prioritize`, `Above bar - optional`, `Optional - attach instead`, `Enabler`. Priority is judged against what the field expects, not against how interesting the work is. A requirement with no priority is a finding.
   - **The explicit "here is the bar and here is where we sit" belongs in the gitignored `private/` directory**, bar by bar, with a buy-versus-build call per gap aimed at OSS users. A published spec must not carry a competitive self-assessment. If a document under review contains one, that is a finding: move it and leave the priority behind.

   Reuse the framing the repo already uses rather than inventing another: attach an external tool where the job is offline analysis over history; build where it is on the reply path, writes to the system of record, or encodes this deployment's own rules. A declined item stays declined, with its reasoning intact - a gap nobody intends to close must not sit in a backlog looking like work.

## The structure a spec is reviewed against

Overview; Business Problem (3 to 4 sentences); Personas, each with its goal and a table of that persona's use cases; Functional Requirements and Acceptance Criteria as a table naming the validating e2e test and a status; Non-Goals - Out of Scope as a table linking the spec that does cover each item; User Experience Description and Mocks; Related Documents.

A design doc references its spec, is efficient with words, and carries labelled diagrams - Mermaid especially - in preference to prose describing a flow.

The machine-parsed header block above the first section (`**Status:**`, `**Coverage:**`, `**Related:**`, `**Site section:**`) is required on top of that structure, and `backend/test/e2e-coverage-matrix.test.ts` enforces it.

## Argument Parsing

- If no arguments: review all project documentation
- If a file path is provided: review only that document
- If `--as <roles>` is provided: review as those specific team members (comma-separated)
- If no `--as` flag: review as ALL team members

## Team Member Perspectives

### Product
- Analytics and telemetry for user engagement
- Feature flags and A/B testing controls
- User tier enforcement documentation (Basic/Standard/Premium)
- Conversion paths from sign-up through agent interaction
- Admin dashboard data coverage

### Principal Engineer
- Technical debt and architecture decisions (CDK stack split, provider hierarchy)
- Test coverage and infrastructure (Jest, Playwright)
- Dependency management and CDK upgrades
- Build tooling consistency between frontend (Vite) and backend (CDK)
- Architecture decision records under `docs/design/decisions/`

### Developer
- Code examples accuracy in CLAUDE.md and README
- Local dev setup (frontend dev server, CDK deploy steps, .env wiring from stack outputs)
- Pre-commit hooks and DX tooling
- Hot reload behavior
- `.env.example` completeness vs actual stack outputs

### Visual Designer
- Design tokens documentation (`docs/guides/developer/DESIGN-SYSTEM.md`, CSS custom properties)
- Theming and CSS organization
- Component style guide
- Mobile responsiveness notes
- Tier-color usage consistency across admin tabs and conversation views

### UX
- Loading states (typing indicators, placeholder messages, task pulses)
- Error message guidelines
- Retry logic and resilience patterns (bedrock-resilience surfacing in UI)
- Keyboard navigation and accessibility
- Mention UX (`@all`, `@assistant`) + slash-command UX (`/battle`) discoverability

### AppSec (Application Security)
- Credential and secrets handling (no AWS account IDs in tracked files)
- CORS and API Gateway throttling (`SECURITY.md`)
- IAM least-privilege per stack and tier-tag conditions
- PII / prompt-injection handling via Bedrock Guardrails
- Cognito tier-group enforcement and channel-flow gating

### Legal
- License headers and attribution (MIT)
- Data retention (DDB TTL, S3 lifecycle, Aurora archival)
- Audit logging requirements
- Data processing agreements (Bedrock, Chime SDK)

### QA
- Test strategy and coverage goals
- Unit / integration / E2E test documentation (23 Playwright tests + Jest)
- Test independence (no reliance on prior-run users or channels)
- Regression testing procedures
- Critical-path coverage: signup, signin, agent interaction, admin dashboard

### PM (Program Manager)
- Definition of Done and release criteria
- Delivery metrics and success criteria for v0.2.0
- Backlog organization across launch threads

## Documents to Review

If reviewing all docs, check:
- `CLAUDE.md` (project instructions, build/run, architecture, configuration)
- `README.md`
- `CONTRIBUTING.md`
- `docs/overview/ARCHITECTURE.md`
- `SECURITY.md`
- `docs/guides/developer/MODEL_STRATEGY.md`
- `docs/guides/admin/AURORA-MODE-GUIDE.md`
- `docs/guides/user/IDENTITY-PROVIDER-GUIDE.md`
- `docs/guides/developer/CHIME_SDK_INTEGRATION.md`
- `docs/guides/developer/DESIGN-SYSTEM.md`
- `docs/guides/admin/TAGGING.md`
- All specs under `docs/SPEC-*.md`
- All plans under `docs/PLAN-*.md`
- All decision records under `docs/design/decisions/`

## Review Process

1. Read each document thoroughly
2. Cross-reference with the actual codebase for accuracy (use file paths + line numbers when calling out drift)
3. Note inconsistencies, outdated info, or gaps — especially when a doc describes behavior the code no longer implements (or vice versa)
4. Provide specific recommendations with concrete diffs where possible

## Output Format

For each team member perspective, provide:

### [Role Name] Review

**Document:** [filename]

| Issue | Location | Severity | Recommendation |
|-------|----------|----------|----------------|
| ... | Line X or Section Y | High/Medium/Low | Specific fix |

**Summary:** Brief overall assessment from this perspective

---

## Final Summary

After all reviews, provide:

### Consolidated Recommendations

Prioritized list of changes, grouped by:
1. **Critical** - Incorrect/dangerous information (security gaps, broken setup steps, wrong commands)
2. **Important** - Outdated or misleading content (references to renamed files, removed features, stale roadmap items)
3. **Minor** - Improvements for clarity

### Proposed Changes

For each recommendation, show the specific edit needed. Ask user which changes to apply.
