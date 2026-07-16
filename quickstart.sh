#!/usr/bin/env bash
set -euo pipefail

# AgentEchelon Quick Start
# Validates prerequisites, deploys the backend, populates the frontend .env,
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
header "Deploying AgentEchelon (~14 stacks)"

cd backend
npx cdk deploy --all --require-approval never \
  --outputs-file ../cdk-outputs.json \
  2>&1 | grep -E "✅|Outputs|error|fail" || true
cd ..

[[ -f cdk-outputs.json ]] || fail "Deploy failed — cdk-outputs.json not generated."
info "All stacks deployed"

# --- Populate frontend .env ---
header "Configuring frontend"

# Extract outputs from the JSON
get_output() {
  local stack="$1" key="$2"
  python3 -c "
import json, sys
data = json.load(open('cdk-outputs.json'))
stack_data = data.get('$stack', {})
for k, v in stack_data.items():
    if '$key' in k:
        print(v)
        sys.exit(0)
sys.exit(1)
" 2>/dev/null || echo ""
}

USER_POOL_ID=$(get_output AgentEchelonCognitoAuth UserPoolId)
CLIENT_ID=$(get_output AgentEchelonCognitoAuth UserPoolClientId)
IDENTITY_POOL_ID=$(get_output AgentEchelonCognitoAuth IdentityPoolId)
APP_INSTANCE_ARN=$(get_output AgentEchelonChimeMessaging AppInstanceArn)
CRED_EXCHANGE_URL=$(get_output AgentEchelonCognitoAuth CredentialExchangeApiUrl)
CREATE_CONV_URL=$(get_output AgentEchelonFoundations CreateConversationApiUrl)
ADD_BOT_URL=$(get_output AgentEchelonFoundations AddAgentApiUrl)
PRESIGNED_URL=$(get_output AgentEchelonS3Storage PresignedUrlApiUrl)
SHARE_URL=$(get_output AgentEchelonNotifications ShareApiUrl)
ANALYTICS_URL=$(get_output AgentEchelonAnalytics AnalyticsApiUrl)
USER_MGMT_URL=$(get_output AgentEchelonCognitoAuth UserManagementApiUrl)
ADMIN_CONV_URL=$(get_output AgentEchelonCognitoAuth AdminConversationApiUrl)
FEEDBACK_URL=$(get_output AgentEchelonCognitoAuth UserFeedbackApiUrl)

cat > frontend/.env << ENVEOF
VITE_AWS_REGION=$AWS_REGION
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_CLIENT_ID=$CLIENT_ID
VITE_IDENTITY_POOL_ID=$IDENTITY_POOL_ID
VITE_APP_INSTANCE_ARN=$APP_INSTANCE_ARN
VITE_CREDENTIAL_EXCHANGE_API_URL=$CRED_EXCHANGE_URL
VITE_CREATE_CONVERSATION_API_URL=$CREATE_CONV_URL
VITE_ADD_BOT_API_URL=$ADD_BOT_URL
VITE_PRESIGNED_URL_API_URL=$PRESIGNED_URL
VITE_SHARE_CONVERSATION_API_URL=$SHARE_URL
VITE_ANALYTICS_API_URL=$ANALYTICS_URL
VITE_USER_MANAGEMENT_API_URL=$USER_MGMT_URL
VITE_ADMIN_CONVERSATIONS_API_URL=$ADMIN_CONV_URL
VITE_USER_FEEDBACK_API_URL=$FEEDBACK_URL
ENVEOF

info "frontend/.env populated with stack outputs"

# --- Create test admin user ---
header "Creating test admin user"

if [[ -z "$ADMIN_EMAIL" ]]; then
  read -rp "Enter email for admin user: " ADMIN_EMAIL
fi

[[ -n "$ADMIN_EMAIL" ]] || fail "Email required."

# Temporary password — the operator sets a permanent one on first sign-in
# (NEW_PASSWORD_REQUIRED). create-admin-user.sh creates the Cognito user, adds
# it to the premium + admins groups (the authoritative signal), and creates the
# Chime AppInstance User. Idempotent-ish: a re-run on an existing user just warns.
ADMIN_PASSWORD="Tmp$(date +%s | tail -c 6)Aa1!"
AWS_REGION="$AWS_REGION" USER_POOL_ID="$USER_POOL_ID" APP_INSTANCE_ARN="$APP_INSTANCE_ARN" \
  bash scripts/create-admin-user.sh "$ADMIN_EMAIL" "$ADMIN_PASSWORD" \
  || warn "Admin creation reported an issue (the user may already exist)."

info "Admin user ready: $ADMIN_EMAIL"

# --- Summary ---
header "AgentEchelon is ready"

echo -e "  ${BOLD}Frontend:${NC}  cd frontend && npm run dev"
echo -e "  ${BOLD}Login:${NC}     $ADMIN_EMAIL"
echo -e "  ${BOLD}Temp password:${NC}  $ADMIN_PASSWORD  ${BOLD}(you'll set a permanent one on first sign-in)${NC}"
echo -e "  ${BOLD}Tier:${NC}      premium (admin)"
echo ""
echo -e "  Open ${BOLD}http://localhost:5173${NC} after starting the dev server."
echo ""
echo -e "  ${BOLD}Production hosting:${NC} the AgentEchelonFrontend stack (CloudFront + S3) was"
echo -e "  deployed above. Publish the built app to it with: ${BOLD}cd backend && npm run deploy-frontend${NC}"
echo -e "  Then set ${BOLD}--context appUrl=https://<DistributionUrl>${NC} and redeploy for CORS."
echo -e "  Full guide: docs/FRONTEND-DEPLOY.md"
echo ""

# Optionally publish to CloudFront (the AgentEchelonFrontend bucket + distribution
# already exist from the deploy above; this builds + syncs + invalidates).
read -rp "Publish the frontend to CloudFront now? [y/N] " PUBLISH_CF
if [[ "${PUBLISH_CF:-N}" =~ ^[Yy]$ ]]; then
  (cd backend && npm run deploy-frontend)
fi

# Optionally start dev server
read -rp "Start the dev server now? [Y/n] " START_DEV
if [[ "${START_DEV:-Y}" =~ ^[Yy]?$ ]]; then
  cd frontend && npm run dev
fi
