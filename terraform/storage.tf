# Images built by deploy.sh (gcloud builds submit --tag) land here.
resource "google_artifact_registry_repository" "repo" {
  location      = var.region
  repository_id = var.repository_id
  description   = "Container images for the ${var.service_name} Cloud Run service"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

# Uploads, analysis artifacts and renders, used by the app when
# STUDIO_GCS_BUCKET is set. Objects are scratch data for one editing session,
# so a lifecycle rule deletes them after var.retention_days.
resource "google_storage_bucket" "media" {
  name                        = "${var.project_id}-${var.service_name}-media"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  cors {
    origin          = ["*"]
    method          = ["GET", "HEAD", "PUT", "POST", "OPTIONS"]
    response_header = ["Content-Type", "Content-Length", "Content-Range", "X-Goog-Resumable"]
    max_age_seconds = 3600
  }

  lifecycle_rule {
    condition {
      age = var.retention_days
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}
