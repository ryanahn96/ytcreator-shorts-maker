# Why these settings:
#
# - h2c: Cloud Run caps HTTP/1 request bodies at 32 MiB, which would reject
#   most Source Video uploads. The container runs Hypercorn, which speaks h2c
#   (HTTP/2 without TLS), so naming the port "h2c" makes Cloud Run use HTTP/2
#   end to end (the Terraform spelling of `gcloud run deploy --use-http2`).
# - several instances are fine: uploads, analysis artifacts, renders and OAuth
#   sessions live in the GCS media bucket (STUDIO_GCS_BUCKET), not only on the
#   instance, so the requests of one editing session do not have to reach one
#   instance.
# - 3600 s timeout: the analysis NDJSON stream stays open for many minutes;
#   60 minutes is Cloud Run's maximum.
# - gen2 execution environment: full Linux kernel, faster for ffmpeg.
# - cpu_idle: CPU is billed per request. Every long operation (upload, the
#   analysis stream, render) happens inside a request, so nothing runs in the
#   background between requests.
# - invoker_iam_disabled = true: creators sign in
#   inside the app with their own Google/YouTube account via OAuth 2.0 (which
#   grants YouTube Data API and YouTube Analytics API tokens). Disabling the
#   invoker IAM check opens the HTTPS endpoint without an `allUsers` IAM policy
#   binding that `constraints/iam.allowedPolicyMemberDomains` would reject.
resource "google_cloud_run_v2_service" "studio" {
  name                 = var.service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account       = google_service_account.runtime.email
    timeout               = "3600s"
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image_uri

      ports {
        name           = "h2c"
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "GOOGLE_GENAI_USE_VERTEXAI"
        value = "true"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "STUDIO_GCS_BUCKET"
        value = google_storage_bucket.media.name
      }
      env {
        name  = "GOOGLE_OAUTH_CLIENT_ID"
        value = var.oauth_client_id
      }
      env {
        name  = "GOOGLE_OAUTH_CLIENT_SECRET"
        value = var.oauth_client_secret
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_project_service.apis,
    # The first revision must be able to reach Vertex AI, Speech, and the bucket.
    google_project_iam_member.runtime_vertex,
    google_project_iam_member.runtime_speech,
    google_storage_bucket_iam_member.runtime_media,
  ]
}
