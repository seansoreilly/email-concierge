# Each Lambda's dist/index.mjs is produced by the sibling service's esbuild
# build script at the path in local.lambda_dist_path (the hard contract with
# services/*-lambda). Terraform owns zipping + the source hash so the build
# script only needs to emit the .mjs, not a zip.
data "archive_file" "poll" {
  type        = "zip"
  source_file = local.lambda_dist_path.poll
  output_path = "${path.module}/../services/poll-lambda/dist/lambda.zip"
}

data "archive_file" "draft" {
  type        = "zip"
  source_file = local.lambda_dist_path.draft
  output_path = "${path.module}/../services/draft-lambda/dist/lambda.zip"
}

data "archive_file" "api" {
  type        = "zip"
  source_file = local.lambda_dist_path.api
  output_path = "${path.module}/../services/api-lambda/dist/lambda.zip"
}

# ---------------------------------------------------------------------------
# poll-lambda: reads/writes emails + sync_state, reads Gmail OAuth secret.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "poll" {
  name               = "${local.lambda_names.poll}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name = "${local.lambda_names.poll}-role"
  }
}

resource "aws_iam_role_policy_attachment" "poll_basic_execution" {
  role       = aws_iam_role.poll.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "poll" {
  name = "${local.lambda_names.poll}-policy"
  role = aws_iam_role.poll.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ]
        Resource = [
          aws_dynamodb_table.emails.arn,
          aws_dynamodb_table.sync_state.arn,
        ]
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.gmail_oauth.arn
      },
    ]
  })
}

resource "aws_lambda_function" "poll" {
  function_name = local.lambda_names.poll
  role          = aws_iam_role.poll.arn
  runtime       = local.lambda_runtime
  handler       = local.lambda_handler

  filename         = data.archive_file.poll.output_path
  source_code_hash = data.archive_file.poll.output_base64sha256

  # 300s (not the earlier 90s) - a first-run 7-day backfill processes up to
  # ~20 messages per invocation (get + classify + batchModify each), which
  # at 1-2s per message can approach the old timeout on a real inbox.
  timeout     = 300
  memory_size = 512

  reserved_concurrent_executions = 1

  environment {
    variables = {
      EMAILS_TABLE_NAME      = aws_dynamodb_table.emails.name
      SYNC_STATE_TABLE_NAME  = aws_dynamodb_table.sync_state.name
      GMAIL_OAUTH_SECRET_ARN = aws_secretsmanager_secret.gmail_oauth.arn
      ANTHROPIC_API_KEY      = var.anthropic_api_key
      OPENROUTER_API_KEY     = var.openrouter_api_key
      ARCHIVE_ENABLED        = tostring(var.archive_enabled)
    }
  }

  tags = {
    Name = local.lambda_names.poll
  }
}

# ---------------------------------------------------------------------------
# draft-lambda: reads/writes emails table, consumes its DynamoDB Stream,
# reads Gmail OAuth secret (to create the Gmail draft via the API).
# ---------------------------------------------------------------------------
resource "aws_iam_role" "draft" {
  name               = "${local.lambda_names.draft}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name = "${local.lambda_names.draft}-role"
  }
}

resource "aws_iam_role_policy_attachment" "draft_basic_execution" {
  role       = aws_iam_role.draft.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "draft" {
  name = "${local.lambda_names.draft}-policy"
  role = aws_iam_role.draft.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ]
        Resource = aws_dynamodb_table.emails.arn
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams",
        ]
        Resource = "${aws_dynamodb_table.emails.arn}/stream/*"
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.gmail_oauth.arn
      },
    ]
  })
}

resource "aws_lambda_function" "draft" {
  function_name = local.lambda_names.draft
  role          = aws_iam_role.draft.arn
  runtime       = local.lambda_runtime
  handler       = local.lambda_handler

  filename         = data.archive_file.draft.output_path
  source_code_hash = data.archive_file.draft.output_base64sha256

  timeout     = 90
  memory_size = 512

  environment {
    variables = {
      EMAILS_TABLE_NAME      = aws_dynamodb_table.emails.name
      GMAIL_OAUTH_SECRET_ARN = aws_secretsmanager_secret.gmail_oauth.arn
      ANTHROPIC_API_KEY      = var.anthropic_api_key
      OPENROUTER_API_KEY     = var.openrouter_api_key
    }
  }

  tags = {
    Name = local.lambda_names.draft
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
resource "aws_lambda_event_source_mapping" "emails_stream_to_draft" {
  event_source_arn  = aws_dynamodb_table.emails.stream_arn
  function_name     = aws_lambda_function.draft.arn
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

  depends_on = [aws_iam_role_policy.draft]
}

# ---------------------------------------------------------------------------
# api-lambda: reads/writes emails table (list + corrections), reads Gmail
# OAuth secret (corrections may call back to Gmail to relabel/undo a draft).
# ---------------------------------------------------------------------------
resource "aws_iam_role" "api" {
  name               = "${local.lambda_names.api}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name = "${local.lambda_names.api}-role"
  }
}

resource "aws_iam_role_policy_attachment" "api_basic_execution" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "api" {
  name = "${local.lambda_names.api}-policy"
  role = aws_iam_role.api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ]
        Resource = aws_dynamodb_table.emails.arn
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.gmail_oauth.arn
      },
    ]
  })
}

resource "aws_lambda_function" "api" {
  function_name = local.lambda_names.api
  role          = aws_iam_role.api.arn
  runtime       = local.lambda_runtime
  handler       = local.lambda_handler

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  timeout     = 30
  memory_size = 256

  environment {
    variables = {
      EMAILS_TABLE_NAME      = aws_dynamodb_table.emails.name
      GMAIL_OAUTH_SECRET_ARN = aws_secretsmanager_secret.gmail_oauth.arn
    }
  }

  tags = {
    Name = local.lambda_names.api
  }
}

# Shared assume-role policy document (identical trust policy for all three
# Lambda execution roles - Lambda is always the assuming service).
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}
