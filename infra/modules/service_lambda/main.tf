# LEARN: A MODULE is just a folder of .tf files that other code calls like a
# function. The caller (`module "poll" { source = "./modules/service_lambda" }`
# in ../../lambda.tf) passes arguments that become this folder's `variable`s
# (variables.tf), and reads results via its `output`s (outputs.tf).
#
# Why a module here? Every Lambda in this project needs the same five things:
# a zip, an IAM role, a logging permission, an inline policy, and the function.
# Writing that 3x (4x with the Cognito trigger) invites drift, so it is written
# once and instantiated per Lambda. Resources inside a module are namespaced:
# the poll Lambda's role is `module.poll.aws_iam_role.this` in state.
#
# Resources inside are all named "this" - the usual convention when a module
# creates exactly one of a kind.

# One Lambda + its execution role + inline policy + zip. Every function in this
# stack has the same shape; only the code, sizing, env and permissions differ.

# LEARN: `archive_file` is a data source from the "archive" provider. It runs
# locally during plan, zips the file, and exposes the zip's path and hash.
# Lambda needs a zip (or container) - esbuild only produces index.mjs, so
# Terraform packages it.
data "archive_file" "this" {
  type        = "zip"
  source_file = var.source_file
  # LEARN: dirname() is a built-in function returning a path's directory.
  # The zip is written next to the source (that is why *.zip is git-ignored).
  output_path = "${dirname(var.source_file)}/lambda.zip"
}

# LEARN: The "trust policy" (aka assume-role policy) answers WHO may use this
# role: here, only the Lambda service. It is separate from the "permissions
# policy" (below) which answers WHAT the role may do.
#
# aws_iam_policy_document is a data source that builds IAM JSON from HCL. It
# is preferred over hand-written jsonencode({...}) because Terraform checks the
# structure and the HCL is easier to read and merge.
data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# The Lambda's identity. When the function runs, AWS gives it temporary
# credentials for this role, and everything it calls (DynamoDB, Secrets
# Manager) is authorised against the role's policies - least privilege.
resource "aws_iam_role" "this" {
  name = var.role_name
  # LEARN: `.json` is an attribute of the policy-document data source: the
  # rendered policy as a JSON string, which is what the IAM API wants.
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
}

# LEARN: AWS-managed policy (referenced by its fixed ARN, not created here)
# that lets the function write logs to CloudWatch. Without it the Lambda runs
# but you could never see its console output.
resource "aws_iam_role_policy_attachment" "basic_execution" {
  # LEARN: `aws_iam_role.this.name` is a REFERENCE to another resource's
  # attribute. Terraform reads these to build a dependency graph: it knows
  # the role must exist before this attachment, so no ordering is written by
  # hand. Resources with no references between them are created in parallel.
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# The role's custom permissions: what THIS service may do (e.g. read one
# DynamoDB table). The JSON is built by the caller and passed in, so this
# module stays generic.
resource "aws_iam_role_policy" "this" {
  name   = "${var.function_name}-policy"
  role   = aws_iam_role.this.id
  policy = var.policy_json
}

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  role          = aws_iam_role.this.arn
  runtime       = "nodejs22.x"
  # "index.handler" = the exported `handler` function in index.mjs.
  handler = "index.handler"

  filename = data.archive_file.this.output_path
  # LEARN: Terraform decides whether to redeploy by comparing this hash to
  # state. Without it, editing code would not change any Terraform-visible
  # argument and `apply` would see "no changes". The hash makes code changes
  # show up in `plan`. (Hence: `pnpm -r build` BEFORE `terraform plan`.)
  source_code_hash = data.archive_file.this.output_base64sha256

  timeout     = var.timeout
  memory_size = var.memory_size
  # null (the variable's default) means "argument not set" - no reservation.
  reserved_concurrent_executions = var.reserved_concurrent_executions

  environment {
    variables = var.environment
  }
}
