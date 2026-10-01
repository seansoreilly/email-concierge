# Restricts Google federated sign-in to the single allowed user
# (var.cognito_user_email), and links the federated Google identity to that
# existing Cognito user instead of letting Cognito auto-provision a new
# "Google_<sub>" profile - which it does by default on first federated
# sign-in, ignoring the user pool's admin_create_user_only setting (that
# setting only gates native SignUp/AdminCreateUser, not IdP federation).
#
# Runs on the PreSignUp_ExternalProvider trigger (first federated sign-in
# only - once the identity is linked, Cognito resolves straight to the
# existing user). Any Google account whose email doesn't match the allowed
# user is rejected outright; a match gets AdminLinkProviderForUser'd onto the
# existing native-user profile, so the emails table access already scoped to
# that one user needs no changes elsewhere (API Gateway's JWT authorizer only
# checks iss/aud - this trigger is the only place emails are actually gated
# to one identity).
#
# The handler is infra/lambda/cognito-pre-signup/index.mjs; see its comments
# for the AdminLinkProviderForUser specifics.

# AdminLinkProviderForUser/AdminGetUser must be scoped to this specific user
# pool - neither is resource-scopable to a single user within the pool, so
# the trigger's own email check (thrown before either call) is what does the
# restricting.
data "aws_iam_policy_document" "cognito_pre_signup" {
  statement {
    actions = [
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminLinkProviderForUser",
    ]
    resources = [aws_cognito_user_pool.main.arn]
  }
}

# LEARN: The SAME module as poll/draft/api, called a 4th time with different
# inputs - the payoff of the module. Differences are only data: a bundled
# source file instead of an esbuild output, tiny sizing, one env var.
module "cognito_pre_signup" {
  source = "./modules/service_lambda"

  function_name = "${local.name_prefix}-cognito-pre-signup"
  role_name     = "${local.iam_name_prefix}-cognito-pre-signup-role"
  source_file   = "${path.module}/lambda/cognito-pre-signup/index.mjs"
  policy_json   = data.aws_iam_policy_document.cognito_pre_signup.json

  timeout     = 10
  memory_size = 128

  environment = {
    ALLOWED_EMAIL = var.cognito_user_email
  }
}

# LEARN: Same "resource-based permission" pattern as API Gateway in
# apigateway.tf: without it Cognito's trigger call is denied. `source_arn`
# restricts the grant to THIS user pool (not any pool in the account).
resource "aws_lambda_permission" "cognito_invoke_pre_signup" {
  statement_id  = "AllowCognitoInvokePreSignUp"
  action        = "lambda:InvokeFunction"
  function_name = module.cognito_pre_signup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}

moved {
  from = aws_iam_role.cognito_pre_signup
  to   = module.cognito_pre_signup.aws_iam_role.this
}
moved {
  from = aws_iam_role_policy_attachment.cognito_pre_signup_basic_execution
  to   = module.cognito_pre_signup.aws_iam_role_policy_attachment.basic_execution
}
moved {
  from = aws_iam_role_policy.cognito_pre_signup
  to   = module.cognito_pre_signup.aws_iam_role_policy.this
}
moved {
  from = aws_lambda_function.cognito_pre_signup
  to   = module.cognito_pre_signup.aws_lambda_function.this
}
