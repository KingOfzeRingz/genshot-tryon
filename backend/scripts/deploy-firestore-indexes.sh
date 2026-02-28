#!/bin/bash
set -euo pipefail

# Deploy Firestore composite indexes required by the TryOn backend.
# Usage:
#   ./scripts/deploy-firestore-indexes.sh
#   ./scripts/deploy-firestore-indexes.sh /path/to/.env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${1:-$BACKEND_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

# shellcheck disable=SC2046
export $(grep -v '^#' "$ENV_FILE" | xargs)

if [[ -z "${GCP_PROJECT_ID:-}" ]]; then
  echo "GCP_PROJECT_ID must be set in $ENV_FILE"
  exit 1
fi

DATABASE_ID="${FIRESTORE_DATABASE:-(default)}"

echo "Deploying Firestore indexes"
echo "  project:  $GCP_PROJECT_ID"
echo "  database: $DATABASE_ID"

set +e
OUTPUT=$(
  gcloud firestore indexes composite create \
    --project="$GCP_PROJECT_ID" \
    --database="$DATABASE_ID" \
    --collection-group="generations" \
    --field-config="field-path=user_id,order=ascending" \
    --field-config="field-path=created_at,order=descending" 2>&1
)
STATUS=$?
set -e

if [[ $STATUS -eq 0 ]]; then
  echo "Created index: generations(user_id ASC, created_at DESC)"
  exit 0
fi

if echo "$OUTPUT" | grep -qiE "already exists|ALREADY_EXISTS"; then
  echo "Index already exists: generations(user_id ASC, created_at DESC)"
  exit 0
fi

echo "$OUTPUT"
exit 1
