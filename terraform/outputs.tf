output "service_url" {
  description = "HTTPS URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.studio.uri
}

output "media_bucket" {
  description = "GCS bucket the app uses for uploads, analysis artifacts and renders."
  value       = google_storage_bucket.media.name
}

output "runtime_service_account" {
  description = "Service account the container runs as (Vertex AI and bucket access)."
  value       = google_service_account.runtime.email
}

output "image_repository" {
  description = "Artifact Registry repository path that deploy.sh pushes images to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.repository_id}"
}
