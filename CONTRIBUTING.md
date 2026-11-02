# Contributing to AgentEchelon

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/AgentEchelon.git`
3. Create a branch: `git checkout -b feature/your-feature`
4. Install dependencies:
   ```bash
   cd frontend && npm ci
   cd ../backend && npm ci
   cd ../tests && npm ci
   ```
   Use `npm ci` (exact, lockfile-pinned install), not `npm install`. The repo's committed `.npmrc` files also set `ignore-scripts=true` to block install-time dependency scripts - see [docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md](docs/guides/developer/SECURITY-NPM-SUPPLY-CHAIN.md).

## Development Setup

### Prerequisites

- Node.js 20+ (matches the Lambda runtime)
- AWS CLI configured with credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- Access to Amazon Bedrock models in your AWS account

### Running Locally

```bash
# Deploy backend (requires AWS account)
cd backend
cdk bootstrap aws://ACCOUNT-ID/REGION
cp deploy.config.example.json deploy.config.json   # then edit it (see README "Deploy Backend")
npm run deploy   # builds, applies deploy.config.json, runs the safety and rollback checks, and writes the frontend .env files

# Point the backend's CORS at the dev server (one chat origin at a time)
npm run deploy -- --context appUrl=http://localhost:5173

# Start the chat dev server (frontend/packages/chat/.env is written by the deploy;
# or generate it with node backend/scripts/gen-frontend-env.mjs)
cd ../frontend
npm run dev:chat
```

Deploy one stack with `npm run deploy:stack -- <Stack>`, never a raw `cdk deploy`, which forwards none of the persisted context.

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

### The four layers

AgentEchelon is four layers, each running on the one below ([`docs/overview/PLATFORM-OVERVIEW.md`](docs/overview/PLATFORM-OVERVIEW.md#how-it-is-built-four-layers)). Every change names the layer it belongs to and keeps to that layer's job.

- **Interface** is the clients people use: the chat app, the admin console, the widget. A client renders, holds a bearer-pinned identity and reaches the engine through Communication. It decides nothing about access, and either platform client can be replaced without touching the engine.
- **Communication** is the connectivity that wires a client to the engine. Adding a channel never changes the engine: it is one adapter and one registry entry.
- **Interaction** is the engine: AgentEchelon's code over the AWS services it composes, where identity, classification and conversation access are enforced in IAM. A new experience is configuration over the engine (a conversation type, an assistant version, a workflow), not a new code path.
- **Foundations** is how the platform is deployed and operated: the stacks, the tags that attribute cost (the same tags IAM reads) and the monitoring. It provisions what Interaction enforces and enforces nothing of its own.

A service is not a layer, and the layers are not deploy units. The Amazon Chime SDK and Cognito each span three layers, and Interaction and Foundations together make up the core, which always deploys whole. What a deployer chooses is the components and capabilities below.

### Deploy only what you declare

A deployment is the required core plus the capabilities `backend/deploy.config.json` declares in `capabilities`, so an adopter stands up only the pieces they want (tenet D10). Every change keeps that true. The stack placement, the component rule and the deploy order are in [`docs/overview/STACKS.md`](docs/overview/STACKS.md), and the decision is [ADR-055](docs/design/decisions/055-stacks-are-capabilities-in-layers.md).

1. **The core depends on nothing optional.** No required stack imports, resolves or grants on a resource an optional capability owns, and no core handler needs one to answer a turn.
2. **A capability adds its own stacks and nothing else.** Where it must reach into the core (an environment variable, a grant, a route), the change is an attach point declared on its entry in `backend/lib/config/capabilities.ts`, and the core stack is otherwise unchanged by declaring it.
3. **Absent means off, never broken.** Core code reads a capability's attach point as optional and behaves as if the capability does not exist when it is absent: no error, no retry, no warning on every turn. `experiment-manager.ts` reading an empty `EXPERIMENTS_TABLE` as "no experiments" is the pattern.
4. **A capability needs another only through `requires`.** `battle` requires `experiments`, and synth refuses a configuration that declares one without the other. Nothing else creates a dependency between capabilities.
5. **The components keep their order.** The core first; the chat interface and the admin backend on the core; the admin interface on the admin backend. The admin backend is present or absent as one unit.
6. **A new capability arrives complete.** It has a registry entry in `capabilities.ts` with its stacks, attach points and requirements; a configuration in `backend/test/deploy-matrix/configurations.ts` that declares it; and its description in `deploy.config.example.json`, `AGENTS.md` and `STACKS.md`. A capability that is not built yet is refused at synth, never shipped behind a switch.
7. **Every configuration still synthesizes.** The deploy matrix (`backend/test/deploy-matrix/`) synthesizes each configuration and checks that it stands up exactly the stacks it declares, that each SSM parameter is published by a stack deployed earlier, that the component rule holds, and that adding a capability changes nothing outside its attach points. A change that breaks any of these is fixed in the change, never parked as a skip or an expected failure.

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
- Report security vulnerabilities privately, as described in [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
