#!/bin/bash
# Manual Amplify Hosting deploy: build the SPA locally, zip web/dist's contents
# (not the dist/ directory itself - index.html must sit at the zip root), and
# push it via the Amplify manual-deployment API (create-deployment -> upload ->
# start-deployment). Used because this app has no GitHub connection - see
# infra/amplify.tf for why.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

echo "==> Reading Terraform outputs"
cd infra
APP_ID="$(terraform output -raw amplify_app_id)"
BRANCH_NAME="$(terraform output -raw amplify_branch_name)"
DEFAULT_DOMAIN="$(terraform output -raw amplify_default_domain)"
USER_POOL_ID="$(terraform output -raw cognito_user_pool_id)"
CLIENT_ID="$(terraform output -raw cognito_user_pool_client_id)"
API_URL="$(terraform output -raw api_invoke_url)"
cd "$REPO_ROOT"

echo "==> Writing web/.env.production"
cat > web/.env.production <<EOF
VITE_COGNITO_USER_POOL_ID=${USER_POOL_ID}
VITE_COGNITO_CLIENT_ID=${CLIENT_ID}
VITE_API_URL=${API_URL}
EOF

echo "==> Building web/"
pnpm --filter @email-concierge/web build

echo "==> Zipping web/dist contents"
ZIP_PATH="$REPO_ROOT/web/dist.zip"
rm -f "$ZIP_PATH"
python3 -c "
import os, zipfile
dist_dir = 'web/dist'
zip_path = 'web/dist.zip'
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(dist_dir):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, dist_dir)
            zf.write(full, rel)
"

echo "==> Creating Amplify deployment"
CREATE_OUTPUT="$(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH_NAME")"
JOB_ID="$(echo "$CREATE_OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["jobId"])')"
UPLOAD_URL="$(echo "$CREATE_OUTPUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["zipUploadUrl"])')"

echo "==> Uploading zip (job $JOB_ID)"
curl -s -X PUT -T "$ZIP_PATH" "$UPLOAD_URL" -H "Content-Type: application/zip"

echo "==> Starting deployment"
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH_NAME" --job-id "$JOB_ID" > /dev/null

echo "==> Polling deployment status"
for _ in $(seq 1 30); do
  STATUS="$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH_NAME" --job-id "$JOB_ID" --query 'job.summary.status' --output text)"
  echo "    status: $STATUS"
  if [ "$STATUS" = "SUCCEED" ]; then
    echo "==> Deployed: https://${BRANCH_NAME}.${DEFAULT_DOMAIN}"
    exit 0
  fi
  if [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "CANCELLED" ]; then
    echo "Deployment $STATUS" >&2
    exit 1
  fi
  sleep 5
done

echo "Timed out waiting for deployment to finish" >&2
exit 1
