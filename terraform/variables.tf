variable "project_id" {
  description = "Google Cloud project that hosts Cloud Run, Vertex AI and the media bucket."
  type        = string
  default     = "ytcreator-508301"
}

variable "region" {
  description = "Region for Cloud Run, Artifact Registry and the media bucket."
  type        = string
  default     = "asia-northeast3"
}

variable "service_name" {
  description = "Cloud Run service name. Also prefixes the runtime service account and the media bucket."
  type        = string
  default     = "ytcreator"
}

variable "image_uri" {
  description = "Full Artifact Registry image URI including its tag (or digest), e.g. asia-northeast3-docker.pkg.dev/PROJECT/ytcreator/ytcreator:abc1234. deploy.sh builds the image with Cloud Build and passes this in."
  type        = string
}

variable "oauth_client_id" {
  description = "Google OAuth 2.0 Web Client ID for creator sign-in and YouTube Data/Analytics API access (GOOGLE_OAUTH_CLIENT_ID)."
  type        = string
  default     = ""
}

variable "oauth_client_secret" {
  description = "Google OAuth 2.0 Web Client Secret (GOOGLE_OAUTH_CLIENT_SECRET)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "cpu" {
  description = "CPU limit per instance. ffmpeg renders are CPU bound."
  type        = string
  default     = "4"
}

variable "memory" {
  description = "Memory limit per instance. Uploads are decoded in memory while they are analyzed and rendered."
  type        = string
  default     = "8Gi"
}

variable "min_instances" {
  description = "Minimum number of instances. 0 scales to zero when idle; 1 removes cold starts at the price of an idle instance."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum number of instances. Media lives in GCS, so instances are interchangeable."
  type        = number
  default     = 5
}

variable "retention_days" {
  description = "Age in days after which objects in the media bucket are deleted (GCS lifecycle rule)."
  type        = number
  default     = 1
}

variable "repository_id" {
  description = "Artifact Registry repository (Docker format) that holds the service image."
  type        = string
  default     = "ytcreator"
}
