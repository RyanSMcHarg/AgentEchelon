#!/usr/bin/env bash
#
# Create the first admin user for Agent Echelon.
#
# Creates a Cognito user with premium tier + admin approval, adds it to the
# `premium` and `admins` Cognito groups (the authoritative tier/admin signal),
# and creates the corresponding Chime SDK AppInstance User required for
# messaging. The account is created with a TEMPORARY password and Cognito's
# FORCE_CHANGE_PASSWORD state — on first sign-in the app prompts the operator to
# set a permanent password (no real password is baked in or emailed).
#
# Usage:
#   ./scripts/create-admin-user.sh <email> [temporary-password]
#   ./scripts/create-admin-user.sh admin@example.com          # auto-generates a temp password
#   ./scripts/create-admin-user.sh admin@example.com 'Temp-P@ss1'
#
# Prerequisites:
#   - AWS CLI configured (aws sso login / aws configure)
#   - CDK stacks deployed (User Pool + Chime AppInstance exist)
#   - frontend/.env populated with stack outputs (or export USER_POOL_ID / APP_INSTANCE_ARN)
#
# Environment variables (optional):
#   AWS_PROFILE       AWS CLI profile
#   USER_POOL_ID      Cognito User Pool ID (default: reads from frontend/.env)
#   APP_INSTANCE_ARN  Chime AppInstance ARN (default: reads from frontend/.env)

set -euo pipefail

# ── Args ──
if [ $# -lt 1 ]; then
  echo "Usage: $0 <email> [temporary-password]"
  echo ""
  echo "Creates an admin user (premium tier, pre-approved, in the admins group)."
  echo "The operator sets a permanent password on first sign-in."
  exit 1
fi

EMAIL="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Temp password: take arg 2, else generate one that meets the pool policy
# (>=8 chars, upper + lower + digit + symbol).
if [ $# -ge 2 ]; then
  TEMP_PW="$2"
else
  TEMP_PW="Tmp$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 10)A1!"
fi

# ── Load config from .env ──
ENV_FILE="$PROJECT_DIR/frontend/.env"
if [ -f "$ENV_FILE" ]; then
  USER_POOL_ID="${USER_POOL_ID:-$(grep VITE_USER_POOL_ID "$ENV_FILE" | cut -d= -f2 | tr -d '\r')}"
  APP_INSTANCE_ARN="${APP_INSTANCE_ARN:-$(grep VITE_APP_INSTANCE_ARN "$ENV_FILE" | cut -d= -f2 | tr -d '\r')}"
fi

if [ -z "${USER_POOL_ID:-}" ] || [ -z "${APP_INSTANCE_ARN:-}" ]; then
  echo "Error: USER_POOL_ID and APP_INSTANCE_ARN must be set."
  echo "Either populate frontend/.env or export them as environment variables."
  exit 1
fi

PROFILE_FLAG=""
if [ -n "${AWS_PROFILE:-}" ]; then
  PROFILE_FLAG="--profile $AWS_PROFILE"
fi

echo "Creating admin user: $EMAIL"
echo "  User Pool: $USER_POOL_ID"
echo "  AppInstance: ${APP_INSTANCE_ARN##*/}"
echo ""

# ── Step 1: Create Cognito user with a temporary password (FORCE_CHANGE_PASSWORD) ──
echo "[1/5] Creating Cognito user (temporary password)..."
aws cognito-idp admin-create-user $PROFILE_FLAG \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes \
    Name=email,Value="$EMAIL" \
    Name=email_verified,Value=true \
    Name=custom:tier,Value=premium \
    Name=custom:approved,Value=true \
  --temporary-password "$TEMP_PW" \
  --message-action SUPPRESS \
  --output text > /dev/null

# ── Step 2: Add to the premium + admins groups (authoritative tier/admin signal) ──
echo "[2/5] Adding to premium + admins groups..."
for group in premium admins; do
  aws cognito-idp admin-add-user-to-group $PROFILE_FLAG \
    --user-pool-id "$USER_POOL_ID" \
    --username "$EMAIL" \
    --group-name "$group"
done

# ── Step 3: Get user sub ──
echo "[3/5] Retrieving user sub..."
SUB=$(aws cognito-idp admin-get-user $PROFILE_FLAG \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --query 'UserAttributes[?Name==`sub`].Value' --output text)

# ── Step 4: Create Chime AppInstance User ──
echo "[4/5] Creating Chime AppInstance User..."
aws chime-sdk-identity create-app-instance-user $PROFILE_FLAG \
  --app-instance-arn "$APP_INSTANCE_ARN" \
  --app-instance-user-id "$SUB" \
  --name "$EMAIL" \
  --output text > /dev/null

# ── Step 5: Done ──
echo "[5/5] Done."
echo ""
echo "Admin user created."
echo "  Email:             $EMAIL"
echo "  Temporary password: $TEMP_PW"
echo "  Tier:              premium   Groups: premium, admins   Approved: true"
echo "  Sub:               $SUB"
echo ""
echo "Sign in with the temporary password — the app will prompt you to set a"
echo "permanent one on first sign-in (NEW_PASSWORD_REQUIRED)."
