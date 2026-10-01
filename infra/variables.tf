# LEARN: A `variable` is an INPUT to the configuration - like a function
# parameter. Declared here, referenced elsewhere as `var.<name>`.
#
# Where values come from (highest precedence first):
#   1. -var / -var-file flags on the command line
#   2. *.auto.tfvars files
#   3. terraform.tfvars   (git-ignored here; see terraform.tfvars.example)
#   4. TF_VAR_<name> environment variables
#   5. the `default` below
# A variable with NO default (like the keys below) must be supplied, or
# Terraform prompts for it interactively.

variable "aws_region" {
  type    = string
  default = "ap-southeast-2"
}

variable "project_name" {
  type    = string
  default = "email-concierge"
}

variable "cognito_user_email" {
  description = "The single allowed user's email address for the Cognito user pool"
  type        = string
  # LEARN: sensitive = true hides the value in plan/apply output ("(sensitive
  # value)"). It does NOT encrypt it: the value is still stored in plain text
  # in state - which is why the state bucket has encrypt = true.
  sensitive = true
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
  # LEARN: `type` makes Terraform validate input (a string where a bool is
  # expected is an error). Common types: string, number, bool, list(string),
  # map(string), object({...}).
  type = bool
  # A feature flag: flipping this to true in terraform.tfvars and applying
  # changes poll-lambda's ARCHIVE_ENABLED env var (see lambda.tf).
  default = false
}
