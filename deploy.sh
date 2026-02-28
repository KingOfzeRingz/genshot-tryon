#!/usr/bin/env bash
#
# GenShot TryOn — GCP Setup & Deploy Script
#
# Usage:
#   ./deploy.sh setup          # One-time GCP project setup
#   ./deploy.sh deploy         # Build & deploy backend to Cloud Run
#   ./deploy.sh setup+deploy   # Both in sequence
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Docker installed (for local builds) or gcloud configured for Cloud Build
#
# Environment variables (override defaults):
#   GCP_PROJECT_ID   — your GCP project ID
#   GCP_REGION       — Cloud Run region (default: us-central1)
#   SERVICE_NAME     — Cloud Run service name (default: genshot-tryon-api)
#   GCS_BUCKET       — GCS bucket for assets

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────
GCP_PROJECT_ID="${GCP_PROJECT_ID:-genshot-studio}"
GCP_REGION="${GCP_REGION:-europe-west1}"
SERVICE_NAME="${SERVICE_NAME:-genshot-tryon-api}"
GCS_BUCKET="${GCS_BUCKET:-genshot-tryon-mobile}"
FIRESTORE_DATABASE="${FIRESTORE_DATABASE:-genshot-tryon-mobile}"
IMAGE="gcr.io/${GCP_PROJECT_ID}/${SERVICE_NAME}"
HMAC_SECRET="${HMAC_SECRET:-$(openssl rand -hex 16)}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="${SCRIPT_DIR}/backend"

# ── Colours ───────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────
check_prerequisites() {
    command -v gcloud >/dev/null 2>&1 || fail "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
    info "gcloud CLI found: $(gcloud version 2>/dev/null | head -1)"
}

# ── Setup ─────────────────────────────────────────────────────────────
do_setup() {
    info "Setting up GCP project: ${GCP_PROJECT_ID}"

    # Set project
    gcloud config set project "${GCP_PROJECT_ID}" 2>/dev/null
    ok "Project set to ${GCP_PROJECT_ID}"

    # Enable required APIs
    info "Enabling APIs (this may take a minute)..."
    gcloud services enable \
        run.googleapis.com \
        cloudbuild.googleapis.com \
        firestore.googleapis.com \
        storage.googleapis.com \
        aiplatform.googleapis.com \
        containerregistry.googleapis.com \
        artifactregistry.googleapis.com \
        2>/dev/null || true
    ok "APIs enabled"

    # Create Firestore database (if it doesn't exist)
    info "Creating Firestore database (native mode)..."
    gcloud firestore databases create \
        --location="${GCP_REGION}" \
        --type=firestore-native \
        2>/dev/null || warn "Firestore database may already exist (that's fine)"
    ok "Firestore ready"

    # Create GCS bucket
    info "Creating GCS bucket: ${GCS_BUCKET}"
    gcloud storage buckets create "gs://${GCS_BUCKET}" \
        --location="${GCP_REGION}" \
        --uniform-bucket-level-access \
        2>/dev/null || warn "Bucket may already exist (that's fine)"

    # Make bucket publicly readable for serving images
    gcloud storage buckets update "gs://${GCS_BUCKET}" \
        --add-acl-grant=entity=allUsers,role=READER \
        2>/dev/null || \
    gsutil iam ch allUsers:objectViewer "gs://${GCS_BUCKET}" \
        2>/dev/null || warn "Could not set public access — set manually if needed"
    ok "GCS bucket ready: ${GCS_BUCKET}"

    # Firebase setup reminder
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  Manual Firebase steps needed:${NC}"
    echo -e "${YELLOW}  1. Go to https://console.firebase.google.com${NC}"
    echo -e "${YELLOW}  2. Add your GCP project (${GCP_PROJECT_ID})${NC}"
    echo -e "${YELLOW}  3. Enable Authentication → Apple Sign-In${NC}"
    echo -e "${YELLOW}  4. Download service account key JSON${NC}"
    echo -e "${YELLOW}  5. Place it at: backend/firebase-credentials.json${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    ok "Setup complete"
}

# ── Deploy ────────────────────────────────────────────────────────────
do_deploy() {
    info "Deploying backend to Cloud Run..."

    # Build with Cloud Build (no local Docker needed)
    info "Building container image with Cloud Build..."
    cd "${BACKEND_DIR}"

    gcloud builds submit \
        --tag "${IMAGE}:latest" \
        --timeout=600 \
        --quiet

    ok "Image built: ${IMAGE}:latest"

    # Deploy to Cloud Run
    info "Deploying to Cloud Run: ${SERVICE_NAME} in ${GCP_REGION}..."
    gcloud run deploy "${SERVICE_NAME}" \
        --image "${IMAGE}:latest" \
        --region "${GCP_REGION}" \
        --platform managed \
        --allow-unauthenticated \
        --port 8080 \
        --memory 1Gi \
        --cpu 1 \
        --min-instances 0 \
        --max-instances 3 \
        --timeout 300 \
        --set-env-vars "\
GCP_PROJECT_ID=${GCP_PROJECT_ID},\
GCS_BUCKET=${GCS_BUCKET},\
FIRESTORE_DATABASE=${FIRESTORE_DATABASE},\
HMAC_SECRET=${HMAC_SECRET},\
CORS_ORIGINS=[\"*\"],\
LOG_LEVEL=INFO,\
VERTEX_LOCATION=us-central1" \
        --quiet

    # Get the service URL
    SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
        --region "${GCP_REGION}" \
        --format "value(status.url)" 2>/dev/null)

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Deployment successful!${NC}"
    echo -e "${GREEN}  Service URL: ${SERVICE_URL}${NC}"
    echo -e "${GREEN}  Health check: ${SERVICE_URL}/health${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${CYAN}Next steps:${NC}"
    echo -e "  1. Update extension API base URL to: ${SERVICE_URL}"
    echo -e "  2. Update iOS app Secrets.swift:  static let apiBaseURL = \"${SERVICE_URL}\""
    echo -e "  3. Test: curl ${SERVICE_URL}/health"
    echo ""

    ok "Deploy complete"
}

# ── Local run ─────────────────────────────────────────────────────────
do_local() {
    info "Building and running backend locally with Docker..."
    cd "${BACKEND_DIR}"

    docker build -t genshot-tryon-api .
    ok "Image built"

    info "Starting on http://localhost:8080 ..."
    info "Press Ctrl+C to stop"
    docker run --rm -it \
        -p 8080:8080 \
        -e GCP_PROJECT_ID="${GCP_PROJECT_ID}" \
        -e GCS_BUCKET="${GCS_BUCKET}" \
        -e FIRESTORE_DATABASE="${FIRESTORE_DATABASE}" \
        -e HMAC_SECRET="${HMAC_SECRET}" \
        -e CORS_ORIGINS='["*"]' \
        -e LOG_LEVEL=DEBUG \
        -e VERTEX_LOCATION=us-central1 \
        -v "${BACKEND_DIR}/firebase-credentials.json:/app/firebase-credentials.json:ro" \
        -e FIREBASE_CREDENTIALS_PATH=/app/firebase-credentials.json \
        genshot-tryon-api
}

# ── Main ──────────────────────────────────────────────────────────────
case "${1:-help}" in
    setup)
        check_prerequisites
        do_setup
        ;;
    deploy)
        check_prerequisites
        do_deploy
        ;;
    setup+deploy)
        check_prerequisites
        do_setup
        do_deploy
        ;;
    local)
        do_local
        ;;
    *)
        echo "GenShot TryOn — Deploy Script"
        echo ""
        echo "Usage:"
        echo "  $0 setup          One-time GCP project setup (APIs, Firestore, GCS)"
        echo "  $0 deploy         Build & deploy backend to Cloud Run"
        echo "  $0 setup+deploy   Both in sequence"
        echo "  $0 local          Build & run locally with Docker"
        echo ""
        echo "Environment overrides:"
        echo "  GCP_PROJECT_ID=${GCP_PROJECT_ID}"
        echo "  GCP_REGION=${GCP_REGION}"
        echo "  SERVICE_NAME=${SERVICE_NAME}"
        echo "  GCS_BUCKET=${GCS_BUCKET}"
        ;;
esac
