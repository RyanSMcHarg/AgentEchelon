#!/usr/bin/env bash
set -euo pipefail

# AgentEchelon Quick Start
# Validates prerequisites, deploys through npm run deploy (which writes each frontend package .env),
# creates a test admin user, and starts the dev server.
#
# Usage:
#   ./quickstart.sh                        # Interactive (prompts for email)
#   ./quickstart.sh --email you@example.com # Non-interactive
#
# Prerequisites: Node.js 20+, AWS CLI v2, CDK CLI, configured AWS credentials

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[x]${NC} $*"; exit 1; }
header() { echo -e "\n${BOLD}=== $* ===${NC}\n"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Parse args ---
ADMIN_EMAIL=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --email) ADMIN_EMAIL="$2"; shift 2;;
    *) fail "Unknown argument: $1";;
  esac
done

# --- Prerequisites ---
header "Checking prerequisites"

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node.js 20+."
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js 20+ required (found: $(node --version))"
info "Node.js $(node --version)"

command -v aws >/dev/null 2>&1 || fail "AWS CLI not found. Install AWS CLI v2."
info "AWS CLI $(aws --version 2>&1 | head -1)"

command -v npx >/dev/null 2>&1 || fail "npx not found."
info "npx available"

# Verify AWS credentials
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || \
  fail "AWS credentials not configured. Run 'aws configure' or 'aws sso login'."
AWS_REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
info "AWS Account: $AWS_ACCOUNT  Region: $AWS_REGION"

# Check Bedrock model access
info "Checking Bedrock model access..."
MODELS=$(aws bedrock list-foundation-models \
  --query 'modelSummaries[?starts_with(modelId, `anthropic`)].modelId' \
  --output text --region "$AWS_REGION" 2>/dev/null || echo "")
if [[ -z "$MODELS" ]]; then
  warn "Could not verify Bedrock model access. Ensure Anthropic models are enabled in $AWS_REGION."
else
  info "Bedrock models available"
fi

# --- Install dependencies ---
header "Installing dependencies"

info "Installing backend dependencies..."
(cd backend && npm ci --silent)

info "Installing frontend dependencies..."
(cd frontend && npm ci --silent)

# --- CDK Bootstrap ---
header "Bootstrapping CDK"

npx --yes cdk bootstrap "aws://$AWS_ACCOUNT/$AWS_REGION" 2>&1 | tail -3
info "CDK bootstrapped"

# --- Deploy ---
header "Deploying AgentEchelon"

# npm run deploy is the guarded deploy: it reads backend/deploy.config.json, refuses a stack outside
# this instance, writes frontend/packages/{chat,admin}/.env from the live outputs and publishes each
# declared app. A first run starts from the example, which declares chat, admin, notifications,
# experiments and battle.
if [[ ! -f backend/deploy.config.json ]]; then
  cp backend/deploy.config.example.json backend/deploy.config.json
  warn "Created backend/deploy.config.json from the example. Review senderEmail and capabilities in it."
fi

(cd backend && AWS_REGION="$AWS_REGION" npm run deploy) || fail "Deploy failed; the output above names the step."
info "All stacks deployed; frontend/packages/{chat,admin}/.env written from their outputs"

# This deployment's stack-name prefix, from the same resolver every operator script uses
# (backend/scripts/lib/stack-lookup.cjs), so the shell and the scripts never disagree about it.
STACK_PREFIX=$(node -e "process.stdout.write(require(require('path').resolve(process.argv[1])).resolveStackPrefix())"   "$SCRIPT_DIR/backend/scripts/lib/stack-lookup.cjs") || fail "Could not resolve the stack prefix."

# --- Create test admin user ---
header "Creating test admin user"

if [[ -z "$ADMIN_EMAIL" ]]; then
  read -rp "Enter email for admin user: " ADMIN_EMAIL
fi

[[ -n "$ADMIN_EMAIL" ]] || fail "Email required."

# provision-admin.mjs creates the Cognito user, adds it to the premium + admins
# groups (the authoritative signal), and creates the Chime AppInstance User. It is
# idempotent and resolves the user pool + app instance from CFN outputs itself. For a
# local quickstart we hand you a TEMPORARY password (ADMIN_TEMP_PASSWORD, email
# suppressed); you set your own permanent one on first sign-in. A real deployment omits
# it to email a Cognito invite instead.
ADMIN_TEMP_PASSWORD="Tmp$(date +%s | tail -c 6)Aa1!"
( cd backend && AWS_REGION="$AWS_REGION" ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_TEMP_PASSWORD="$ADMIN_TEMP_PASSWORD" \
    node scripts/provision-admin.mjs ) \
  || warn "Admin creation reported an issue (the user may already exist)."

info "Admin user ready: $ADMIN_EMAIL"

# --- Summary ---
header "AgentEchelon is ready"

echo -e "  ${BOLD}Frontend:${NC}  cd frontend && npm run dev:chat"
echo -e "  ${BOLD}Login:${NC}     $ADMIN_EMAIL"
echo -e "  ${BOLD}Temp password:${NC}  $ADMIN_TEMP_PASSWORD  ${BOLD}(you'll set a permanent one on first sign-in)${NC}"
echo -e "  ${BOLD}Tier:${NC}      premium (admin)"
echo ""
echo -e "  Open ${BOLD}http://localhost:5173${NC} after starting the dev server."
echo ""
echo -e "  ${BOLD}Production hosting:${NC} npm run deploy published the chat app to the ${STACK_PREFIX}ChatApp stack"
echo -e "  (CloudFront + S3) and allowed its origin; the URL is in the deploy summary above."
echo -e "  Full guide: docs/guides/user/FRONTEND-DEPLOY.md"
echo ""

# Optionally start dev server
read -rp "Start the dev server now? [Y/n] " START_DEV
if [[ "${START_DEV:-Y}" =~ ^[Yy]?$ ]]; then
  cd frontend && npm run dev:chat
fi
