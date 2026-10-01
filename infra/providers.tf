# =============================================================================
# START HERE - a map of this directory
# =============================================================================
# LEARN: Terraform reads EVERY *.tf file in a directory and merges them into
# one configuration. File names and order mean nothing to Terraform - they are
# purely for humans. Splitting by AWS service (dynamodb.tf, cognito.tf, ...) is
# just a convention. Any resource can reference any other, in any file.
#
# Suggested reading order, simplest -> most involved:
#   1. providers.tf / state.tf   which cloud, which version, where state lives
#   2. variables.tf / locals.tf  inputs, and values computed once and reused
#   3. dynamodb.tf, secrets.tf   plain resources, no dependencies on others
#   4. modules/service_lambda/   a reusable "function" - the module pattern
#   5. lambda.tf                 calls that module 3x + IAM policy documents
#   6. eventbridge.tf, monitoring.tf, apigateway.tf   wiring things together
#   7. cognito.tf, cognito_pre_signup.tf, amplify.tf  auth + hosting
#   8. outputs.tf                values printed after apply / read by scripts
#
# The four core Terraform concepts, as they show up here:
#   resource "type" "name" {}   something Terraform creates and manages.
#                               Address: type.name  (e.g. aws_dynamodb_table.emails)
#   data "type" "name" {}       something Terraform only READS (it already
#                               exists, or is computed). Address: data.type.name
#   variable / local / output   inputs / private computed values / results
#   module "name" {}            a folder of .tf files called like a function
#
# Day-to-day commands (run from infra/):
#   terraform init       download providers/modules, connect to remote state
#   terraform validate   syntax + reference check, no AWS calls
#   terraform plan       compare config vs. state vs. real AWS; PRINT the diff
#   terraform apply      do it (manual and local in this repo - CI never applies)
#   terraform fmt        auto-format all files (the linter for HCL)
#
# How `plan` works: Terraform keeps a STATE file (see state.tf) mapping each
# resource address in this code to a real AWS object. plan = "refresh state
# from AWS, diff against the code, show + / ~ / - for create / change / destroy".
# =============================================================================

# LEARN: A "provider" is a plugin that knows how to talk to one API. This one
# is the AWS provider (pinned in state.tf). It is configured once here and
# every aws_* resource in every file uses it automatically.
provider "aws" {
  # LEARN: `var.x` reads an input variable declared in variables.tf. The
  # value comes from terraform.tfvars (git-ignored), -var flags, or the
  # variable's default - in that order of precedence.
  region = var.aws_region

  # LEARN: default_tags stamps these tags on EVERY taggable AWS resource
  # created through this provider, so individual resources don't need their
  # own `tags` blocks. Handy for cost reports ("show me everything tagged
  # Project=email-concierge") and for spotting hand-made vs. Terraform-made
  # resources in the console.
  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

# LEARN: A `data` source is a READ-ONLY lookup. This one asks AWS "which
# account am I authenticated as?" and exposes .account_id. Nothing is created.
# It is used in cognito.tf to build a globally-unique Cognito domain name.
data "aws_caller_identity" "current" {}
