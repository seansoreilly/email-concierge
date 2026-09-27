# Consumed in Phase 3 by aws_amplify_app.environment_variables (VITE_* build-
# time vars for the SPA) and by scripts/oauth-bootstrap.ts (Phase 4).

output "cognito_user_pool_id" {
  description = "Cognito user pool ID - feeds VITE_COGNITO_USER_POOL_ID"
  value       = aws_cognito_user_pool.main.id
}

output "cognito_user_pool_client_id" {
  description = "Cognito app client ID - feeds VITE_COGNITO_CLIENT_ID"
  value       = aws_cognito_user_pool_client.spa.id
}

output "cognito_hosted_ui_domain" {
  description = "Cognito Hosted UI domain (no scheme) - feeds VITE_COGNITO_OAUTH_DOMAIN, used for \"Sign in with Google\" redirects"
  value       = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "api_invoke_url" {
  description = "HTTP API invoke URL - feeds VITE_API_URL"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "dynamodb_emails_table_name" {
  description = "emails table name"
  value       = aws_dynamodb_table.emails.name
}

output "dynamodb_sync_state_table_name" {
  description = "sync_state table name"
  value       = aws_dynamodb_table.sync_state.name
}

output "lambda_function_names" {
  description = "Lambda function names, by role"
  value = {
    poll  = aws_lambda_function.poll.function_name
    draft = aws_lambda_function.draft.function_name
    api   = aws_lambda_function.api.function_name
  }
}

output "lambda_function_arns" {
  description = "Lambda function ARNs, by role"
  value = {
    poll  = aws_lambda_function.poll.arn
    draft = aws_lambda_function.draft.arn
    api   = aws_lambda_function.api.arn
  }
}

output "gmail_oauth_secret_arn" {
  description = "Secrets Manager ARN for the Gmail OAuth secret - consumed by scripts/oauth-bootstrap.ts (Phase 4)"
  value       = aws_secretsmanager_secret.gmail_oauth.arn
}

output "amplify_app_id" {
  description = "Amplify app ID - consumed by scripts/deploy-web.sh for create-deployment/start-deployment"
  value       = aws_amplify_app.web.id
}

output "amplify_branch_name" {
  description = "Amplify branch name - consumed by scripts/deploy-web.sh"
  value       = aws_amplify_branch.mvp.branch_name
}

output "amplify_default_domain" {
  description = "Amplify app's default domain (branch URL is https://<branch>.<this>)"
  value       = aws_amplify_app.web.default_domain
}
