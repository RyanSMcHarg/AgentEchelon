# Contributing to AgentEchelon

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/agent-echelon.git`
3. Create a branch: `git checkout -b feature/your-feature`
4. Install dependencies:
   ```bash
   cd frontend && npm ci
   cd ../backend && npm ci
   cd ../tests && npm ci
   ```
   Use `npm ci` (exact, lockfile-pinned install), not `npm install`. The repo's
   committed `.npmrc` files also set `ignore-scripts=true` to block install-time
   dependency scripts - see [docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md](docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md).

## Development Setup

### Prerequisites

- Node.js 18+
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- Access to Amazon Bedrock models in your AWS account

### Running Locally

```bash
# Deploy backend (requires AWS account)
cd backend
cdk bootstrap aws://ACCOUNT-ID/REGION
cdk deploy --all

# Configure frontend
cd frontend
cp .env.example .env
# Fill in values from CDK stack outputs

# Start dev server
npm run dev
```

### Running Tests

```bash
cd tests
npx playwright install chromium
npm test
```

## Making Changes

### Code Style

- TypeScript throughout (frontend and backend)
- React functional components with hooks
- AWS CDK for all infrastructure

### Commit Messages

Write clear, concise commit messages that explain *why* the change was made:
- `Fix token refresh failing on background tabs`
- `Add file size validation to upload preview`
- `Support Titan model in standard tier`

### Pull Requests

1. Keep PRs focused - one feature or fix per PR
2. Update documentation if you change user-facing behavior
3. Ensure `npm run build` passes for both frontend and backend
4. Add or update tests for new functionality
5. Fill out the PR template with a summary and test plan

## Project Structure

- `frontend/` - React 19 + Vite application
- `backend/` - AWS CDK stacks and Lambda functions
- `tests/` - Playwright E2E tests
- `docs/` - Integration and planning documentation

See the [README](README.md) for detailed architecture and provider hierarchy.

## Security

- Never commit credentials, API keys, or AWS account IDs
- Use `.env` files for configuration (already in `.gitignore`)
- Report security vulnerabilities privately via GitHub Security Advisories

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
