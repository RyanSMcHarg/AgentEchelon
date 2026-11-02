## Summary

What does this PR change? Why?

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation update
- [ ] Infrastructure / CDK change
- [ ] Dependency update

## Related Issues

Closes #

## Changes

- Change 1
- Change 2
- Change 3

## Testing

- [ ] `npm run build` passes in `backend/`
- [ ] `npm run build` passes in `frontend/`
- [ ] `npm run lint` passes in `frontend/`
- [ ] `npx cdk synth` succeeds in `backend/`
- [ ] Playwright E2E tests pass (`cd tests && npm test`)
- [ ] Manually tested on a fresh deploy (describe the scenario)

## Deployment Impact

- [ ] No infrastructure changes
- [ ] Additive infrastructure changes (no data loss risk)
- [ ] Requires migration or manual step (documented below)
- [ ] Breaking infrastructure change (requires major version bump)

If this change requires a migration or manual step, describe it here:

## Layers (see CONTRIBUTING.md, "The four layers" and "Deploy only what you declare")

- [ ] The change names its layer (Interface, Communication, Interaction, Foundations) and keeps to that layer's job
- [ ] The core still deploys and answers with no optional capability declared
- [ ] Any reach into the core is an attach point declared in `backend/lib/config/capabilities.ts`, read as optional
- [ ] A new capability has its registry entry, a deploy-matrix configuration, and its docs
- [ ] The deploy matrix passes (`npm run test:slice -- test/deploy-matrix`)

## Security / Compliance

- [ ] No new IAM permissions
- [ ] New IAM permissions added (listed below with justification)
- [ ] No new PII handling
- [ ] New PII handling (describe data flow and retention)

## Checklist

- [ ] My code follows the style guidelines (lint passes)
- [ ] I have performed a self-review of my code
- [ ] I have commented complex or non-obvious code
- [ ] I have updated documentation where applicable
- [ ] I have added tests for new functionality
- [ ] All existing tests pass
- [ ] No hardcoded account IDs, secrets, or personal information
