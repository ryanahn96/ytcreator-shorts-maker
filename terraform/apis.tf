locals {
  apis = [
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    # Cloud Build in new projects runs as the Compute Engine default service
    # account, which exists only once this API is on.
    "compute.googleapis.com",
    "aiplatform.googleapis.com",
    "speech.googleapis.com",
    "storage.googleapis.com",
    "youtube.googleapis.com",
    "youtubereporting.googleapis.com",
    "youtubeanalytics.googleapis.com",
    # Service accounts (iam) and data.google_project (cloudresourcemanager).
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
