# Single-user Cognito user pool: no self-signup, admin creates the one user.
#
# LEARN: Cognito vocabulary, since the names are confusing:
#   user pool     the user directory (accounts, passwords, tokens)   <- this resource
#   app client    one app allowed to log users in (the SPA)          <- ..._client.spa
#   hosted UI     Cognito-served login pages, needed for Google      <- ..._domain.main
#   identity prov an external login source (Google)                  <- ..._identity_provider.google
# The graph flows pool -> client/domain/IdP/user: each of those takes
# `user_pool_id = aws_cognito_user_pool.main.id`. The pool in turn points at
# the pre-sign-up Lambda (module.cognito_pre_signup) - and that Lambda's IAM
# policy points back at this pool's ARN. Terraform allows this because the two
# links are on different RESOURCES (policy vs. function), so there is no cycle.
resource "aws_cognito_user_pool" "main" {
  name = "${local.name_prefix}-users"

  # LEARN: A nested block with one boolean. Blocks (no `=`) are for structured
  # sub-settings; plain arguments use `=`. Which is which is defined by the
  # provider schema - the registry docs for each resource list both.
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

  # Users sign in with their email address instead of a separate username.
  # Cognito then assigns each user an internal UUID as the real "Username" -
  # that is why the pre-signup Lambda has to look the user up first.
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
    pre_sign_up = module.cognito_pre_signup.arn
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

  # A browser SPA cannot keep a secret (anyone can read its JS), so no secret.
  generate_secret = false

  # SRP = Secure Remote Password: the password is never sent over the wire,
  # only a proof of it. Listing flows explicitly also DISABLES any not listed
  # (e.g. plain USER_PASSWORD_AUTH).
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # The numbers are meaningless without the units block that follows:
  # access/id tokens last 1 hour, the refresh token 30 days. The API Gateway
  # authorizer validates the short-lived ones on every request.
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
  # LEARN: "COGNITO" = the built-in email/password directory; the second entry
  # is a reference to the Google IdP resource, which makes this client depend
  # on it (the IdP must exist before the client can list it).
  supported_identity_providers = ["COGNITO", aws_cognito_identity_provider.google.provider_name]

  # http://localhost is Cognito's one documented exception to "callback URLs
  # must be https" - used for local Vite dev. Must be exactly "localhost",
  # not "127.0.0.1" (Cognito rejects that as non-https), and the Amplify
  # branch subdomain (mvp.<default_domain>) covers the deployed SPA.
  #
  # LEARN: The deployed URL is built from the Amplify resources' attributes.
  # This is the link that makes an Amplify app RECREATE ripple into Cognito:
  # a new app = a new default_domain = this list changes on the next plan.
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
#
# LEARN: `data.aws_caller_identity.current.account_id` reads the data source
# declared in providers.tf - the AWS account number, discovered at plan time.
resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${local.name_prefix}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
}

# Google as a federated IdP. attribute_mapping.username maps Google's `sub`
# to the Cognito federated username (Google_<sub>) - this is NOT how we
# restrict sign-in to one user; that's enforced by the pre-sign-up
# Lambda trigger (cognito_pre_signup.tf), since Cognito auto-provisions a federated user by
# default regardless of admin_create_user_only.
resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  # LEARN: `provider_details` is a MAP argument (uses `=`), the credentials
  # Cognito uses to talk to Google. They come from sensitive variables, so
  # plan output shows "(sensitive value)" instead of the secret.
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
#
# LEARN: Terraform can manage not just infrastructure but also seed DATA like
# this one user. Caveat: Cognito owns the password after creation, so changing
# attributes here later can fight with what the user did themselves.
resource "aws_cognito_user" "single_user" {
  user_pool_id             = aws_cognito_user_pool.main.id
  username                 = var.cognito_user_email
  desired_delivery_mediums = ["EMAIL"]

  attributes = {
    email          = var.cognito_user_email
    email_verified = "true"
  }
}
