variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "email-concierge"
}

variable "cognito_user_email" {
  description = "The single allowed user's email address for the Cognito user pool"
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Anthropic API key for HaikuClassifier fallback and draft-lambda"
  type        = string
  sensitive   = true
}

variable "openrouter_api_key" {
  description = "OpenRouter API key for JevClassifier (typesafe/jev-1.13)"
  type        = string
  sensitive   = true
}

# Google OAuth **web application** client (console.cloud.google.com ->
# Credentials -> Create Credentials -> OAuth Client ID -> Web application).
# Distinct from the "Desktop app" client services/gmail-client uses for Gmail
# API access - this one authenticates a browser sign-in via Cognito's hosted
# UI, not a backend refresh-token flow. Redirect URI to register in GCP:
# https://<cognito_domain_prefix>.auth.<aws_region>.amazoncognito.com/oauth2/idpresponse
variable "google_oauth_client_id" {
  description = "Google OAuth web client ID, used for Cognito Hosted UI \"Sign in with Google\""
  type        = string
  sensitive   = true
}

variable "google_oauth_client_secret" {
  description = "Google OAuth web client secret, paired with google_oauth_client_id"
  type        = string
  sensitive   = true
}

variable "archive_enabled" {
  description = "When true, poll-lambda actually archives (removes INBOX from) messages the shadow-mode policy plans to archive. Default false = shadow mode only."
  type        = bool
  default     = false
}
