# Deliberate choice: the newer EventBridge Scheduler service (aws_scheduler_schedule)
# rather than the legacy CloudWatch Events rule (aws_cloudwatch_event_rule).
# Scheduler is the direction AWS has been pushing recurring-invoke use cases -
# it has a clearer one-shot vs. recurring model, its own IAM role per schedule
# (rather than a shared EventBridge bus rule), and no dependency on a default
# event bus. Worth narrating in an FDE interview as "know the current service,
# not just the one from five years ago."
#
# LEARN: This file shows the standard AWS "who may call whom" pattern, which
# repeats everywhere in this stack:
#   1. a TRUST policy says which service may assume the role (assume_role)
#   2. a PERMISSIONS policy says what the role may do (invoke poll-lambda)
#   3. the resource that needs the access is pointed at the role (role_arn)
# Compare apigateway.tf, which does the same job the other way round: instead
# of a role, it uses a resource-based aws_lambda_permission on the Lambda.
resource "aws_scheduler_schedule" "poll_lambda" {
  name       = "${local.name_prefix}-poll-schedule"
  group_name = "default"

  # OFF = fire exactly on schedule, no random jitter window.
  flexible_time_window {
    mode = "OFF"
  }

  # Cron-like syntax. rate(2 minutes) is the simple form; cron(...) also works.
  schedule_expression = "rate(2 minutes)"

  # LEARN: Both values are references to resources defined elsewhere, so
  # Terraform creates the Lambda (module.poll) and the role (below) first -
  # even though the role appears later in this file. Order in a file is
  # irrelevant; the dependency graph decides.
  target {
    arn      = module.poll.arn
    role_arn = aws_iam_role.scheduler_invoke.arn
  }
}

# EventBridge Scheduler invokes the Lambda directly via this execution role
# (not a resource-based aws_lambda_permission, which is how the legacy
# CloudWatch Events rule model works).
data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "scheduler_invoke" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [module.poll.arn]
  }
}

resource "aws_iam_role" "scheduler_invoke" {
  name               = "${local.iam_name_prefix}-scheduler-invoke-role"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name   = "${local.name_prefix}-scheduler-invoke-policy"
  role   = aws_iam_role.scheduler_invoke.id
  policy = data.aws_iam_policy_document.scheduler_invoke.json
}
