---
name: Bug report
about: Report a problem with agent-echelon
title: '[BUG] '
labels: bug
assignees: ''
---

## Description

A clear and concise description of what the bug is.

## Environment

- **agent-echelon version / commit:**
- **AWS region:**
- **Node version:**
- **CDK version:**
- **Browser (if frontend issue):**
- **Deployment method:** `cdk deploy --all` / script / manual

## Steps to Reproduce

1.
2.
3.

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened. Include error messages, CloudWatch log excerpts, or screenshots where relevant.

## CDK Context (if deployment issue)

```json
{
  "analyticsMode": "athena"
}
```

## CloudWatch Logs (if Lambda issue)

```
<paste relevant log lines here — redact any account IDs, ARNs, or PII>
```

## Additional Context

Any other information that might help diagnose the issue.

---

**Checklist before submitting:**
- [ ] I have searched existing issues for duplicates
- [ ] I have redacted account IDs, ARNs, and PII from logs
- [ ] I can reproduce the issue on a fresh deployment (or noted why not)
