# LEARN: Module outputs are the module's RETURN VALUES - the only way the
# parent can see inside. The parent reads them as `module.<name>.<output>`,
# e.g. `module.poll.arn` in ../../eventbridge.tf. Resources inside the module
# (aws_lambda_function.this, ...) are not directly addressable from outside.
#
# Exposing a few outputs rather than the whole resource keeps the module's
# contract small: callers can't depend on its internals.

output "function_name" {
  value = aws_lambda_function.this.function_name
}

output "arn" {
  value = aws_lambda_function.this.arn
}

output "invoke_arn" {
  # Different from `arn`: API Gateway wants this special "invoke" ARN form
  # (arn:aws:apigateway:...:lambda:path/.../invocations) to call a function.
  value = aws_lambda_function.this.invoke_arn
}
