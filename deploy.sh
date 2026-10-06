#!/usr/bin/env bash
# Builds the studio with Cloud Build and deploys it to Cloud Run.
#
# Gemini runs on Vertex AI with Application Default Credentials (ADC). On
# Cloud Run, ADC is the service account attached to the service, so no API key
# is deployed.
#
# Usage:
#   ./deploy.sh
# Every setting below can be overridden the same way.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-sample-505914}"
REGION="${REGION:-asia-northeast3}"
SERVICE="${SERVICE:-ytcreator}"
# Uploads and renders live in the instance's in-memory file system, so
# memory also caps the size of an uploaded Source Video.
CPU="${CPU:-4}"
MEMORY="${MEMORY:-8Gi}"
# 1 keeps an instance (and its uploads) alive while idle, billed as idle time.
# With 0, uploads are lost when Cloud Run shuts the idle instance down.
MIN_INSTANCES="${MIN_INSTANCES:-0}"

RUNTIME_SA="ytcreator-run@${PROJECT_ID}.iam.gserviceaccount.com"

step() { printf '\n==> %s\n' "$*"; }

# New service accounts take a few seconds to become usable in IAM policies.
retry() {
  local delay
  for delay in 5 10 20 40; do
    "$@" && return
    echo "Retrying in ${delay}s..." >&2
    sleep "${delay}"
  done
  "$@"
}

cd "$(dirname "$0")"

# Runs first without --quiet so gcloud can ask to re-authenticate.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" \
  --format='value(projectNumber)')"

step "Enabling APIs in ${PROJECT_ID}"
# compute: new projects run Cloud Build as the Compute Engine default service
# account, which exists only once this API is on.
gcloud services enable --project="${PROJECT_ID}" \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  aiplatform.googleapis.com

step "Service account for Gemini (ADC): ${RUNTIME_SA}"
if ! gcloud iam service-accounts describe "${RUNTIME_SA}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${RUNTIME_SA%%@*}" \
    --project="${PROJECT_ID}" --display-name="ytcreator Cloud Run"
fi
retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/aiplatform.user \
  --condition=None --quiet >/dev/null

step "Letting Cloud Build build the image"
BUILD_SA="$(gcloud builds get-default-service-account \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format='value(serviceAccountEmail)')"
# The API returns projects/PROJECT/serviceAccounts/EMAIL.
retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${BUILD_SA##*/}" --role=roles/run.builder \
  --condition=None --quiet >/dev/null

step "Building and deploying ${SERVICE} to ${REGION}"
env_file="$(mktemp)"
trap 'rm -f "${env_file}"' EXIT
# --env-vars-file replaces every variable on the service, so a Gemini API key
# can never linger from an earlier deploy.
cat >"${env_file}" <<EOF
GOOGLE_GENAI_USE_VERTEXAI: "true"
GOOGLE_CLOUD_PROJECT: "${PROJECT_ID}"
GOOGLE_CLOUD_LOCATION: "global"
EOF
# --use-http2: h2c to Hypercorn. HTTP/1 caps request bodies at 32 MiB.
# --max-instances=1: uploads and renders are files on the instance, so every
#   request of an editing session must reach the same instance.
# --timeout=3600: an analysis stream can run for many minutes (60 is the max).
# --execution-environment=gen2: full Linux VM, faster for ffmpeg.
gcloud run deploy "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" \
  --source=. \
  --service-account="${RUNTIME_SA}" \
  --env-vars-file="${env_file}" \
  --allow-unauthenticated \
  --no-iap \
  --use-http2 \
  --max-instances=1 \
  --min-instances="${MIN_INSTANCES}" \
  --timeout=3600 \
  --execution-environment=gen2 \
  --cpu="${CPU}" \
  --memory="${MEMORY}" \
  --quiet

# Remove obsolete IAP invoker binding if present
gcloud run services remove-iam-policy-binding "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role=roles/run.invoker --quiet >/dev/null 2>&1 || true

url="$(gcloud run services describe "${SERVICE}" --project="${PROJECT_ID}" \
  --region="${REGION}" --format='value(status.url)')"
step "Deployed: ${url}"
