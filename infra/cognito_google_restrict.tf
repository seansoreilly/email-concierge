# Restricts Google federated sign-in to the single allowed user
# (var.cognito_user_email), and links the federated Google identity to that
# existing Cognito user instead of letting Cognito auto-provision a new
# "Google_<sub>" profile - which it does by default on first federated
# sign-in, ignoring the user pool's admin_create_user_only setting (that
# setting only gates native SignUp/AdminCreateUser, not IdP federation).
#
# Runs on the PreSignUp_ExternalProvider trigger (first federated sign-in
# only - subsequent sign-ins for an already-linked identity skip pre sign-up
# entirely, since by then the identity is linked and Cognito resolves
# straight to the existing user). Any Google account whose email doesn't
# match the allowed user is rejected outright; a match gets
# AdminLinkProviderForUser'd onto the existing native-user profile, so the
# emails table access already scoped to that one user Just Works with no
# changes elsewhere (API Gateway's JWT authorizer only checks iss/aud - this
# trigger is the only place emails are actually gated to one identity).
#
# Per AWS's AdminLinkProviderForUser docs, social IdPs (Google included) only
# accept SourceUser.ProviderAttributeName = "Cognito_Subject" (not "email" -
# that's a SAML/OIDC-only option); the provider attribute value must be the
# provider's own subject id, which is already embedded in event.userName
# ("Google_<sub>") for a federated pre-sign-up event, so no extra Google API
# call is needed to obtain it. DestinationUser needs the pool's actual
# Username, not the email alias - since username_attributes = ["email"],
# that's a Cognito-assigned UUID looked up here via AdminGetUser (email as
# an alias resolves for lookups even though it isn't the Username itself).
data "archive_file" "cognito_pre_signup" {
  type        = "zip"
  output_path = "${path.module}/cognito-pre-signup.zip"

  source {
    filename = "index.mjs"
    content  = <<-JS
      import {
        CognitoIdentityProviderClient,
        AdminGetUserCommand,
        AdminLinkProviderForUserCommand,
      } from "@aws-sdk/client-cognito-identity-provider";

      const client = new CognitoIdentityProviderClient({});
      const allowedEmail = process.env.ALLOWED_EMAIL;

      export async function handler(event) {
        if (event.triggerSource !== "PreSignUp_ExternalProvider") {
          return event;
        }

        const email = event.request.userAttributes.email;
        if (!email || email.toLowerCase() !== allowedEmail.toLowerCase()) {
          throw new Error("This app is restricted to a single Google account.");
        }

        // event.userName is "Google_<sub>" for a federated sign-in - the
        // part after the first "_" is Google's subject id.
        const underscoreIndex = event.userName.indexOf("_");
        const providerName = event.userName.slice(0, underscoreIndex);
        const providerSubject = event.userName.slice(underscoreIndex + 1);

        const destinationUser = await client.send(
          new AdminGetUserCommand({
            UserPoolId: event.userPoolId,
            Username: allowedEmail,
          }),
        );

        await client.send(
          new AdminLinkProviderForUserCommand({
            UserPoolId: event.userPoolId,
            DestinationUser: {
              ProviderName: "Cognito",
              ProviderAttributeValue: destinationUser.Username,
            },
            SourceUser: {
              ProviderName: providerName,
              ProviderAttributeName: "Cognito_Subject",
              ProviderAttributeValue: providerSubject,
            },
          }),
        );

        // Auto-confirm: this is a link to an already-verified native user,
        // not a new signup that needs its own confirmation step.
        event.response.autoConfirmUser = true;
        event.response.autoVerifyEmail = true;

        return event;
      }
    JS
  }
}

resource "aws_iam_role" "cognito_pre_signup" {
  name               = "${local.iam_name_prefix}-cognito-pre-signup-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name = "${local.name_prefix}-cognito-pre-signup-role"
  }
}

resource "aws_iam_role_policy_attachment" "cognito_pre_signup_basic_execution" {
  role       = aws_iam_role.cognito_pre_signup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# AdminLinkProviderForUser/AdminGetUser must be scoped to this specific user
# pool - neither is resource-scopable to a single user within the pool, so
# the trigger's own email check (thrown before either call) is what does the
# restricting.
resource "aws_iam_role_policy" "cognito_pre_signup" {
  name = "${local.name_prefix}-cognito-pre-signup-policy"
  role = aws_iam_role.cognito_pre_signup.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminLinkProviderForUser",
        ]
        Resource = aws_cognito_user_pool.main.arn
      },
    ]
  })
}

resource "aws_lambda_function" "cognito_pre_signup" {
  function_name = "${local.name_prefix}-cognito-pre-signup"
  role          = aws_iam_role.cognito_pre_signup.arn
  runtime       = local.lambda_runtime
  handler       = local.lambda_handler

  filename         = data.archive_file.cognito_pre_signup.output_path
  source_code_hash = data.archive_file.cognito_pre_signup.output_base64sha256

  timeout     = 10
  memory_size = 128

  environment {
    variables = {
      ALLOWED_EMAIL = var.cognito_user_email
    }
  }

  tags = {
    Name = "${local.name_prefix}-cognito-pre-signup"
  }
}

resource "aws_lambda_permission" "cognito_invoke_pre_signup" {
  statement_id  = "AllowCognitoInvokePreSignUp"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cognito_pre_signup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
