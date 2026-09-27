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

  # Gates every federated (Google) sign-in through cognito_pre_signup.tf's
  # restrict-and-link Lambda. SRP sign-in (email/password) is unaffected -
  # this trigger only fires for PreSignUp_ExternalProvider.
  lambda_config {
    pre_sign_up = aws_lambda_function.cognito_pre_signup.arn
  }

  tags = {
    Name = "${local.name_prefix}-users"
  }
}

# Public SPA client - no secret, SRP auth (standard for browser apps that
# can't keep a client secret confidential) plus refresh-token auth for
# session persistence. Also carries the Hosted UI OAuth config for "Sign in
# with Google" - kept on the same client as SRP so the SPA has one client ID
# regardless of which sign-in path the user takes.
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

  # Authorization code grant (not implicit) - the SPA exchanges the code for
  # tokens itself via Amplify, code never sits in the URL bar/history.
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO", aws_cognito_identity_provider.google.provider_name]

  # http://localhost is Cognito's one documented exception to "callback URLs
  # must be https" - used for local Vite dev. Must be exactly "localhost",
  # not "127.0.0.1" (Cognito rejects that as non-https), and the Amplify
  # branch subdomain (mvp.<default_domain>) covers the deployed SPA.
  callback_urls = [
    "http://localhost:5173/",
    "https://${aws_amplify_branch.mvp.branch_name}.${aws_amplify_app.web.default_domain}/",
  ]
  logout_urls = [
    "http://localhost:5173/",
    "https://${aws_amplify_branch.mvp.branch_name}.${aws_amplify_app.web.default_domain}/",
  ]
}

# Hosted UI domain - required for any OAuth/federated flow (SRP-only sign-in
# doesn't need this). Prefix must be globally unique across all Cognito
# users; name_prefix + account id keeps it collision-free without a random
# suffix.
resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${local.name_prefix}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
}

# Google as a federated IdP. attribute_mapping.username maps Google's `sub`
# to the Cognito federated username (Google_<sub>) - this is NOT how we
# restrict sign-in to one user; that's enforced by the pre_sign_up_restrict
# Lambda trigger below, since Cognito auto-provisions a federated user by
# default regardless of admin_create_user_only.
resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_oauth_client_id
    client_secret    = var.google_oauth_client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
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
