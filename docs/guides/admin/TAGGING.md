# Resource Tagging & Cost Attribution

This platform deploys as **multiple independent instances** (one per `AE_INSTANCE_NAME`).
For cost attribution to work, each instance's resources must carry **its own** identity - so
the tagging rule is:

> **Derive `Project` from the deployment identity; never hardcode it, never override it per-stack.**

A hardcoded `Tags.of(app).add('Project', 'AgentEchelon')` (or worse, a per-stack override)
makes every instance report under the same value, collapsing all deployments into one cost
bucket. A guardrail test (`test/tagging.test.ts`) prevents that regression.

## The standard tag set
Applied **once at the app root** in `bin/backend.ts` via `applyStandardTags` (`lib/tagging.ts`):

| Tag | Value | Notes |
|-----|-------|-------|
| `Project` | `STACK_PREFIX` (derived from `AE_INSTANCE_NAME`, e.g. `Acme`) | the per-instance cost identity |
| `Codebase` | `AgentEchelon` | aggregate all instances of this platform |
| `Instance` | `INSTANCE_NAME` (e.g. `acme`) | |
| `Environment` | `-c environment=…` or `Production` | never hardcode |
| `ManagedBy` | `CDK` | |

Individual stacks may add **only** stack-specific keys (e.g. `Component`), never `Project`.

## Rules
1. **Set `Project` once, at the app root**, derived from `STACK_PREFIX`. Deploy the same code
   as a new instance and its tags follow automatically - no code change.
2. **Never** `cdk.Tags.of(this).add('Project', …)` inside a stack/construct. A per-stack
   override wins over the app-root tag and silently fragments cost reports.
3. Cost-allocation tags must be **activated in the Org payer account** before Cost Explorer
   can group by them (they only apply going forward from activation).

## Guardrail (tests)
`test/tagging.test.ts` enforces the invariants and fails CI on a regression:
- `Project` is derived onto resources (+ the full standard set is applied);
- reuse-safety: a different instance self-tags with its own `Project`;
- **guardrail:** a format-agnostic scan (`collectProjectTagValues`) asserts no stack carries a
  `Project` value other than the derived one - this is what catches a stray per-stack override.

Add a stack? Nothing to do for tagging - it inherits the app-root tags. Just don't re-add
`Project`, and the guardrail test will keep it honest.
