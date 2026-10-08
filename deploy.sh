#!/usr/bin/env bash
# Builds the studio image with Cloud Build into Artifact Registry, then applies
# terraform/ so Cloud Run runs it.
#
# - Creators sign in inside the app with their Google/YouTube account via OAuth
#   2.0 (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET), which grants
#   YouTube Data API and YouTube Analytics API tokens. Cloud Run's own invoker
#   IAM check is off (invoker_iam_disabled = true) and IAP is off.
# - Gemini runs on Vertex AI with the runtime service account's Application
#   Default Credentials, so no API key is deployed.
# - Uploads, analysis artifacts, renders and OAuth sessions persist in the GCS
#   media bucket (STUDIO_GCS_BUCKET), so instances are interchangeable and may
#   scale out.
#
# Usage:
#   ./deploy.sh
#   PROJECT_ID=my-project REGION=us-central1 ./deploy.sh
#   TF_VAR_oauth_client_id='...' TF_VAR_oauth_client_secret='...' ./deploy.sh
#
# Every TF_VAR_<variable> in the environment reaches Terraform unchanged, and
# so does terraform/terraform.tfvars (see terraform/terraform.tfvars.example).
# If GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are set in the
# environment, they are forwarded to Terraform unless TF_VAR_oauth_client_* is
# already set.
#
# Tear down: terraform -chdir=terraform destroy -var image_uri=unused

set -euo pipefail

cd "$(dirname "$0")"

# Read settings from .env if present and not already provided in environment
if [[ -f .env ]]; then
  if [[ -z "${PROJECT_ID:-}" ]]; then
    ENV_PROJECT="$(grep -E '^(GOOGLE_CLOUD_PROJECT|PROJECT_ID)=' .env | head -n 1 | cut -d'=' -f2- | tr -d '\r\n'\''"' || true)"
    if [[ -n "${ENV_PROJECT}" ]]; then
      PROJECT_ID="${ENV_PROJECT}"
    fi
  fi
  if [[ -z "${TF_VAR_oauth_client_id:-}" && -z "${GOOGLE_OAUTH_CLIENT_ID:-}" ]]; then
    GOOGLE_OAUTH_CLIENT_ID="$(grep -E '^GOOGLE_OAUTH_CLIENT_ID=' .env | cut -d'=' -f2- | tr -d '\r\n'\''"' || true)"
    if [[ -n "${GOOGLE_OAUTH_CLIENT_ID}" ]]; then
      export GOOGLE_OAUTH_CLIENT_ID
    fi
  fi
  if [[ -z "${TF_VAR_oauth_client_secret:-}" && -z "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]]; then
    GOOGLE_OAUTH_CLIENT_SECRET="$(grep -E '^GOOGLE_OAUTH_CLIENT_SECRET=' .env | cut -d'=' -f2- | tr -d '\r\n'\''"' || true)"
    if [[ -n "${GOOGLE_OAUTH_CLIENT_SECRET}" ]]; then
      export GOOGLE_OAUTH_CLIENT_SECRET
    fi
  fi
fi

PROJECT_ID="${PROJECT_ID:-ytcreator-508301}"
REGION="${REGION:-asia-northeast3}"
SERVICE="${SERVICE:-ytcreator}"
REPOSITORY="${REPOSITORY:-ytcreator}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
TF_DIR="${TF_DIR:-terraform}"

if [[ -z "${TF_VAR_oauth_client_id:-}" && -n "${GOOGLE_OAUTH_CLIENT_ID:-}" ]]; then
  export TF_VAR_oauth_client_id="${GOOGLE_OAUTH_CLIENT_ID}"
fi
if [[ -z "${TF_VAR_oauth_client_secret:-}" && -n "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]]; then
  export TF_VAR_oauth_client_secret="${GOOGLE_OAUTH_CLIENT_SECRET}"
fi

IMAGE_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}"
IMAGE="${IMAGE_PATH}:${IMAGE_TAG}"
# Names terraform/ derives from the settings above; only used to adopt
# resources that already exist.
RUNTIME_SA="${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com"
MEDIA_BUCKET="${PROJECT_ID}-${SERVICE}-media"

step() { printf '\n==> %s\n' "$*"; }

# IAM bindings on brand-new service accounts fail for a few seconds.
retry() {
  local delay
  for delay in 5 10 20 40; do
    "$@" && return
    echo "Retrying in ${delay}s..." >&2
    sleep "${delay}"
  done
  "$@"
}

tf() { terraform -chdir="${TF_DIR}" "$@"; }

if ! command -v terraform >/dev/null; then
  echo "terraform not found: https://developer.hashicorp.com/terraform/install" >&2
  exit 1
fi

# Runs first without --quiet so gcloud can ask to re-authenticate.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" \
  --format='value(projectNumber)')"
step "Deploying ${SERVICE} to ${PROJECT_ID} (${PROJECT_NUMBER}), ${REGION}"

step "Enabling APIs"
# Terraform manages these too, but Cloud Build runs before the first apply.
# compute: new projects run Cloud Build as the Compute Engine default service
# account, which exists only once this API is on.
gcloud services enable --project="${PROJECT_ID}" \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  aiplatform.googleapis.com \
  speech.googleapis.com \
  storage.googleapis.com \
  youtube.googleapis.com \
  youtubereporting.googleapis.com \
  youtubeanalytics.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com

step "Setting up Cloud Build permissions"
BUILD_SA="$(gcloud builds get-default-service-account \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format='value(serviceAccountEmail)')"
# The API returns projects/PROJECT/serviceAccounts/EMAIL.
for role in roles/run.builder roles/storage.objectViewer roles/logging.logWriter; do
  retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${BUILD_SA##*/}" --role="${role}" \
    --condition=None --quiet >/dev/null
done

TF_VARS=(
  -var "project_id=${PROJECT_ID}"
  -var "region=${REGION}"
  -var "service_name=${SERVICE}"
  -var "repository_id=${REPOSITORY}"
)

step "Initializing Terraform in ${TF_DIR}"
tf init -input=false

# An earlier, gcloud-based deploy.sh created some of these resources by hand.
# Terraform cannot create what already exists, so adopt them into the state
# once; afterwards `terraform state show` finds them and this is a no-op.
adopt() { # adopt <address> <import id> <gcloud describe command...>
  local address="$1" id="$2"
  shift 2
  tf state show "${address}" >/dev/null 2>&1 && return 0
  "$@" >/dev/null 2>&1 || return 0
  step "Importing existing ${address}"
  tf import -input=false "${TF_VARS[@]}" -var "image_uri=${IMAGE}" \
    "${address}" "${id}"
}
adopt google_service_account.runtime \
  "projects/${PROJECT_ID}/serviceAccounts/${RUNTIME_SA}" \
  gcloud iam service-accounts describe "${RUNTIME_SA}" --project="${PROJECT_ID}"
adopt google_artifact_registry_repository.repo \
  "projects/${PROJECT_ID}/locations/${REGION}/repositories/${REPOSITORY}" \
  gcloud artifacts repositories describe "${REPOSITORY}" \
  --project="${PROJECT_ID}" --location="${REGION}"
adopt google_storage_bucket.media \
  "${MEDIA_BUCKET}" \
  gcloud storage buckets describe "gs://${MEDIA_BUCKET}"
adopt google_cloud_run_v2_service.studio \
  "projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE}" \
  gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}"

step "Creating the Artifact Registry repository"
# The image must exist before the service that runs it, and the repository
# before the image, so these two go first.
tf apply -input=false -auto-approve "${TF_VARS[@]}" -var "image_uri=${IMAGE}" \
  -target=google_project_service.apis \
  -target=google_artifact_registry_repository.repo

step "Building ${IMAGE}"
# Uploads the repo root minus .gcloudignore; the Dockerfile does the rest.
gcloud builds submit . --project="${PROJECT_ID}" --region="${REGION}" \
  --tag="${IMAGE}"

# Deploy by digest. A rebuild under an unchanged tag (same commit, edited
# tree) would look identical to Terraform and no new revision would roll out.
DIGEST="$(gcloud artifacts docker images describe "${IMAGE}" \
  --format='value(image_summary.digest)' 2>/dev/null || true)"
IMAGE_URI="${IMAGE}"
if [[ -n "${DIGEST}" ]]; then
  IMAGE_URI="${IMAGE_PATH}@${DIGEST}"
fi

step "Applying Terraform"
tf apply -input=false -auto-approve "${TF_VARS[@]}" -var "image_uri=${IMAGE_URI}"

SERVICE_URL="$(tf output -raw service_url)"
step "Deployed: ${SERVICE_URL}"
cat <<EOF

Next steps for Google / YouTube OAuth 2.0 sign-in:
1. In Google Cloud Console > APIs & Services > Credentials, create or edit an
   OAuth 2.0 Web Client and add this Authorized redirect URI:
     ${SERVICE_URL}/api/shortform/auth/callback
2. Configure credentials in .env (single source of truth):
     GOOGLE_OAUTH_CLIENT_ID='...'
     GOOGLE_OAUTH_CLIENT_SECRET='...'
   deploy.sh will automatically export them to Terraform.
EOF
