# Each Lambda's dist/index.mjs is produced by the sibling service's esbuild
# build script at the path in local.lambda_dist_path (the hard contract with
# services/*-lambda). The module owns zipping + the source hash so the build
# script only needs to emit the .mjs, not a zip.
#
# LEARN: This file is the "caller" of modules/service_lambda. Per Lambda it
# does three things:
#   1. builds the IAM permissions JSON the function needs (data "aws_iam_policy_document")
#   2. calls the module with sizing, env vars and that JSON
#   3. (draft only) subscribes it to a DynamoDB stream
# Permissions are built HERE, not in the module, because they differ per
# function and reference this stack's tables/secret.

# LEARN: A `locals` block can appear in any file (they all merge into one
# namespace). This list is shared by all three policies below - define once,
# reuse as `local.dynamodb_rw_actions`.
locals {
  dynamodb_rw_actions = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:Query",
    "dynamodb:Scan",
  ]
}

# LEARN: A policy document used as a reusable FRAGMENT. All three Lambdas need
# to read the Gmail secret, so it is defined once and merged into each Lambda's
# own document via `source_policy_documents` below. Scoped to exactly one
# secret ARN - least privilege.
data "aws_iam_policy_document" "gmail_secret_read" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.gmail_oauth.arn]
  }
}

# ---------------------------------------------------------------------------
# poll-lambda: reads/writes emails + sync_state, reads Gmail OAuth secret.
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "poll" {
  # LEARN: Start from the shared fragment, then ADD this function's own
  # statements. The final JSON = secret-read + the DynamoDB statement below.
  source_policy_documents = [data.aws_iam_policy_document.gmail_secret_read.json]

  statement {
    actions = local.dynamodb_rw_actions
    # poll writes to both tables, so the resource list has two ARNs.
    resources = [
      aws_dynamodb_table.emails.arn,
      aws_dynamodb_table.sync_state.arn,
    ]
  }
}

# LEARN: Calling a module. `source` is the only required meta-argument; every
# other line sets one of the module's input variables (modules/service_lambda/
# variables.tf). After `terraform init` registers the module, resources inside
# live at addresses like module.poll.aws_lambda_function.this.
module "poll" {
  source = "./modules/service_lambda"

  function_name = local.lambda_names.poll
  role_name     = "${local.iam_name_prefix}-poll-lambda-role"
  source_file   = local.lambda_dist_path.poll
  policy_json   = data.aws_iam_policy_document.poll.json

  # 300s (not the earlier 90s) - a first-run 7-day backfill processes up to
  # ~20 messages per invocation (get + classify + batchModify each), which
  # at 1-2s per message can approach the old timeout on a real inbox.
  timeout     = 300
  memory_size = 512

  # At most ONE concurrent invocation: the schedule fires every 2 minutes, and
  # two overlapping polls would race on the Gmail history cursor.
  reserved_concurrent_executions = 1

  # LEARN: Env vars are how infra hands runtime config to code. Note the values
  # are REFERENCES (aws_dynamodb_table.emails.name), not copied strings - if
  # the table were renamed, this Lambda's config updates in the same apply.
  #
  # SECURITY NOTE: the two API keys are plain env vars, so they are visible in
  # the Lambda console and stored in Terraform state (hence the encrypted state
  # bucket and `sensitive = true` on the variables). Secrets Manager (as used
  # for the Gmail token) would be the stricter option.
  environment = {
    EMAILS_TABLE_NAME      = aws_dynamodb_table.emails.name
    SYNC_STATE_TABLE_NAME  = aws_dynamodb_table.sync_state.name
    GMAIL_OAUTH_SECRET_ARN = aws_secretsmanager_secret.gmail_oauth.arn
    ANTHROPIC_API_KEY      = var.anthropic_api_key
    OPENROUTER_API_KEY     = var.openrouter_api_key
    # LEARN: env vars must be strings but the variable is a bool - tostring()
    # converts true -> "true". (Terraform has many such built-in functions:
    # tostring, jsonencode, dirname, lookup, ...)
    ARCHIVE_ENABLED = tostring(var.archive_enabled)
  }
}

# ---------------------------------------------------------------------------
# draft-lambda: reads/writes emails table, consumes its DynamoDB Stream,
# reads Gmail OAuth secret (to create the Gmail draft via the API).
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "draft" {
  source_policy_documents = [data.aws_iam_policy_document.gmail_secret_read.json]

  statement {
    actions   = local.dynamodb_rw_actions
    resources = [aws_dynamodb_table.emails.arn]
  }

  # LEARN: Reading a DynamoDB STREAM is a different permission set on a
  # different resource ARN (".../stream/*") than reading the table. Lambda's
  # stream poller uses the function's role, so the role needs these or the
  # event source mapping below fails to create.
  statement {
    actions = [
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:DescribeStream",
      "dynamodb:ListStreams",
    ]
    resources = ["${aws_dynamodb_table.emails.arn}/stream/*"]
  }
}

module "draft" {
  source = "./modules/service_lambda"

  function_name = local.lambda_names.draft
  role_name     = "${local.iam_name_prefix}-draft-lambda-role"
  source_file   = local.lambda_dist_path.draft
  policy_json   = data.aws_iam_policy_document.draft.json

  timeout     = 90
  memory_size = 512

  environment = {
    EMAILS_TABLE_NAME      = aws_dynamodb_table.emails.name
    GMAIL_OAUTH_SECRET_ARN = aws_secretsmanager_secret.gmail_oauth.arn
    ANTHROPIC_API_KEY      = var.anthropic_api_key
    OPENROUTER_API_KEY     = var.openrouter_api_key
  }
}

# DynamoDB Streams -> draft-lambda.
#
# Filter approach chosen: Terraform-side filter_criteria on both eventName =
# INSERT and the nested NewImage.classification.M.responseState.S value. The
# EmailRecord shape (shared/types.ts) nests responseState under
# classification, so the stream filter's attribute-value-map path must mirror
# that nesting exactly as DynamoDB's low-level AttributeValue JSON: an M
# (map) wrapping the classification object, then an S (string) leaf for
# responseState. This is verbose but not "unwieldy" enough to justify pushing
# the check into application code - filtering at the source means draft-lambda
# is never invoked for the ~80% of mail that isn't "To Respond", which is a
# real cost/latency win worth narrating in an FDE interview ("filtering is
# free, invocations aren't"). draft-lambda still does a defensive early-return
# check on classification.responseState itself, in case poll-lambda's write
# pattern changes to a two-step put-then-update (which would mean the INSERT
# event doesn't carry the classification map yet, and the filter would
# silently drop those records) - see services/draft-lambda's handler.
#
# LEARN: An "event source mapping" is a poller AWS runs for you: it reads the
# stream and invokes the function with batches of records. Nothing calls the
# function directly - this resource is the glue. `stream_arn` only exists
# because stream_enabled = true on the table (dynamodb.tf).
resource "aws_lambda_event_source_mapping" "emails_stream_to_draft" {
  event_source_arn = aws_dynamodb_table.emails.stream_arn
  # LEARN: `module.draft.arn` reads the module's `arn` output.
  function_name = module.draft.arn
  # LATEST = only changes from now on; TRIM_HORIZON would replay the stream's
  # retained history (up to 24h).
  starting_position = "LATEST"

  # Without this, Lambda ignores draft-lambda's batchItemFailures return
  # value entirely - a transient Haiku/Gmail error would mark the whole
  # batch as successfully processed, silently dropping that record forever
  # (draftCreated stays false, no retry, no error surfaced anywhere).
  function_response_types = ["ReportBatchItemFailures"]

  # Caps how long a poison record (one that fails every retry) can block
  # this shard's iterator before Lambda gives up and moves on, rather than
  # retrying for the stream's full 24h retention window.
  maximum_retry_attempts = 3

  filter_criteria {
    filter {
      # LEARN: jsonencode() turns an HCL object into a JSON string. The filter
      # API wants JSON text, but writing it as HCL gives syntax checking and
      # lets you use expressions inside it.
      pattern = jsonencode({
        eventName = ["INSERT"]
        dynamodb = {
          NewImage = {
            classification = {
              M = {
                responseState = {
                  S = ["To Respond"]
                }
              }
            }
          }
        }
      })
    }
  }

  # The stream-read permissions live in the module's inline policy; the
  # mapping fails to create if they aren't attached yet.
  #
  # LEARN: Terraform normally infers ordering from references. Here the
  # mapping references module.draft.arn, which only proves the FUNCTION
  # exists - not that its role's stream policy is attached yet. That
  # dependency is invisible in the code, so it is declared explicitly with
  # `depends_on`. Use it sparingly: only for hidden dependencies like this.
  depends_on = [module.draft]
}

# ---------------------------------------------------------------------------
# api-lambda: reads/writes emails table (list + corrections), reads Gmail
# OAuth secret (corrections may call back to Gmail to relabel/undo a draft).
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "api" {
  source_policy_documents = [data.aws_iam_policy_document.gmail_secret_read.json]

  statement {
    actions   = local.dynamodb_rw_actions
    resources = [aws_dynamodb_table.emails.arn]
  }
}

module "api" {
  source = "./modules/service_lambda"

  function_name = local.lambda_names.api
  role_name     = "${local.iam_name_prefix}-api-lambda-role"
  source_file   = local.lambda_dist_path.api
  policy_json   = data.aws_iam_policy_document.api.json

  timeout     = 30
  memory_size = 256

  environment = {
    EMAILS_TABLE_NAME      = aws_dynamodb_table.emails.name
    GMAIL_OAUTH_SECRET_ARN = aws_secretsmanager_secret.gmail_oauth.arn
  }
}

# Resource addresses moved into modules - keeps the single live state from
# destroying/recreating the roles and functions.
#
# LEARN: Terraform identifies a resource by its ADDRESS in the code. When this
# refactor moved `aws_iam_role.poll` into `module.poll.aws_iam_role.this`,
# Terraform would see the old address vanish (-> destroy) and a new one appear
# (-> create), even though nothing changed in AWS. A `moved {}` block says "same
# object, new address": on the next plan, Terraform renames the entry in state
# instead. Result: no downtime. The blocks are safe to delete once every
# environment (here, the one live state) has applied them.
moved {
  from = aws_iam_role.poll
  to   = module.poll.aws_iam_role.this
}
moved {
  from = aws_iam_role_policy_attachment.poll_basic_execution
  to   = module.poll.aws_iam_role_policy_attachment.basic_execution
}
moved {
  from = aws_iam_role_policy.poll
  to   = module.poll.aws_iam_role_policy.this
}
moved {
  from = aws_lambda_function.poll
  to   = module.poll.aws_lambda_function.this
}

moved {
  from = aws_iam_role.draft
  to   = module.draft.aws_iam_role.this
}
moved {
  from = aws_iam_role_policy_attachment.draft_basic_execution
  to   = module.draft.aws_iam_role_policy_attachment.basic_execution
}
moved {
  from = aws_iam_role_policy.draft
  to   = module.draft.aws_iam_role_policy.this
}
moved {
  from = aws_lambda_function.draft
  to   = module.draft.aws_lambda_function.this
}

moved {
  from = aws_iam_role.api
  to   = module.api.aws_iam_role.this
}
moved {
  from = aws_iam_role_policy_attachment.api_basic_execution
  to   = module.api.aws_iam_role_policy_attachment.basic_execution
}
moved {
  from = aws_iam_role_policy.api
  to   = module.api.aws_iam_role_policy.this
}
moved {
  from = aws_lambda_function.api
  to   = module.api.aws_lambda_function.this
}
