# HTTP API (cheaper + simpler than REST API for this MVP) fronting api-lambda,
# protected by a Cognito JWT authorizer. CORS is permissive (allow_origins =
# "*") to cover both local Vite dev and the eventual Amplify-hosted origin
# without needing to track the exact domain here.
#
# LEARN: An HTTP API is built from several small resources that point at each
# other by id - read this file as a chain:
#   api  <-  stage (where it is published)
#   api  <-  authorizer (JWT check, uses the Cognito pool)
#   api  <-  integration (how to reach the Lambda)
#   api  <-  routes ("GET /emails" -> integration, guarded by authorizer)
#   lambda <- permission (lets API Gateway invoke it)
# Every "api_id = aws_apigatewayv2_api.main.id" is a reference that creates
# the dependency. The "v2" in the names is the HTTP/WebSocket API product,
# not a version of this config.
resource "aws_apigatewayv2_api" "main" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["Authorization", "Content-Type"]
  }
}

# LEARN: A stage is a named, published snapshot of the API. "$default" is the
# special stage served at the root URL (no "/prod" path prefix). auto_deploy =
# true republishes whenever routes change, so you never run a manual "deploy".
# Its `invoke_url` attribute is what outputs.tf hands to the SPA build.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

# JWT authorizer backed by the Cognito user pool. Note: user_pool.endpoint has
# no scheme (cognito-idp.<region>.amazonaws.com/<pool_id>) - issuer requires
# "https://" prefixed manually.
resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.main.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.name_prefix}-cognito-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.spa.id]
    issuer   = "https://${aws_cognito_user_pool.main.endpoint}"
  }
}

# LEARN: The integration describes the backend. AWS_PROXY = pass the whole
# request to Lambda untouched and return its response as-is (no mapping
# templates). payload_format_version "2.0" is the leaner HTTP-API event shape;
# the Lambda code must expect that shape.
resource "aws_apigatewayv2_integration" "api_lambda" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.api.invoke_arn
  payload_format_version = "2.0"
}

# LEARN: A route = "METHOD /path" -> integration. `{messageId}` in the second
# route is a path parameter. The `target` string format ("integrations/<id>")
# is the API's own convention, built here with interpolation. The two routes
# are near-identical on purpose - for_each could collapse them, but with only
# two, explicit blocks read better.
resource "aws_apigatewayv2_route" "list_emails" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "GET /emails"
  target             = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "submit_correction" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "POST /emails/{messageId}/correction"
  target             = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# HTTP API with CORS configured handles OPTIONS preflight itself - no explicit
# OPTIONS route/integration needed.

# LEARN: The OTHER way to grant access (compare the IAM role in eventbridge.tf):
# a RESOURCE-BASED policy attached to the Lambda itself, saying "this principal
# may invoke me". Without it API Gateway gets a 500 even though the integration
# is wired up correctly - a classic first-time gotcha.
# source_arn "<execution_arn>/*/*" = any stage, any method, on THIS API only.
resource "aws_lambda_permission" "api_gateway_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
