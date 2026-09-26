# Single-user Cognito user pool: no self-signup, admin creates the one user.
resource "aws_cognito_user_pool" "main" {
  name = "${local.name_prefix}-users"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

# Public SPA client - no secret, SRP auth (standard for browser apps that
# can't keep a client secret confidential) plus refresh-token auth for
# session persistence.
resource "aws_cognito_user_pool_client" "spa" {
  name         = "${local.name_prefix}-spa-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}

# The single allowed user, created by Terraform (admin-created, no self-signup).
# desired_delivery_mediums = EMAIL because the default is SMS, and no
# phone_number is configured here - without this the invite has nowhere to
# go and the temporary password is unrecoverable. The user will still hit
# Cognito's NEW_PASSWORD_REQUIRED challenge on first SRP login (Phase 3's
# SPA needs to handle that), or the password can be set permanently
# post-apply via `aws cognito-idp admin-set-user-password --permanent`.
resource "aws_cognito_user" "single_user" {
  user_pool_id             = aws_cognito_user_pool.main.id
  username                 = var.cognito_user_email
  desired_delivery_mediums = ["EMAIL"]

  attributes = {
    email          = var.cognito_user_email
    email_verified = "true"
  }
}
