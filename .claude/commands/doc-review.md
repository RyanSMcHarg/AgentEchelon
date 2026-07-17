---
description: "Review docs as team members to find inconsistencies and recommend updates (usage: /doc-review [file] [--as role1,role2]) Roles: product, principal, developer, designer, ux, appsec, legal, qa, pm"
---

Perform a documentation review with the following parameters: $ARGUMENTS

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
