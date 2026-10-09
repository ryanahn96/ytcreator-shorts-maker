# Identity the container runs as. Gemini calls go to Vertex AI with this
# account's Application Default Credentials, so no API key is deployed.
resource "google_service_account" "runtime" {
  account_id   = "${var.service_name}-run"
  display_name = "ytcreator Cloud Run"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "runtime_vertex" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = google_service_account.runtime.member
}

resource "google_project_iam_member" "runtime_speech" {
  project = var.project_id
  role    = "roles/speech.client"
  member  = google_service_account.runtime.member
}

resource "google_storage_bucket_iam_member" "runtime_media" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.runtime.member
}
