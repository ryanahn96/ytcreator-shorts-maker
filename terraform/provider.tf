terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.31"
    }
  }

  # State is local: terraform/terraform.tfstate (git-ignored). To share it
  # between machines, create a bucket once and switch to the GCS backend:
  #
  # backend "gcs" {
  #   bucket = "ytcreator-508301-tfstate"
  #   prefix = "ytcreator"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
