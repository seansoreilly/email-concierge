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
