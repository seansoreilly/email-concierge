# Deliberate choice: the newer EventBridge Scheduler service (aws_scheduler_schedule)
# rather than the legacy CloudWatch Events rule (aws_cloudwatch_event_rule).
# Scheduler is the direction AWS has been pushing recurring-invoke use cases -
# it has a clearer one-shot vs. recurring model, its own IAM role per schedule
# (rather than a shared EventBridge bus rule), and no dependency on a default
# event bus. Worth narrating in an FDE interview as "know the current service,
# not just the one from five years ago."
resource "aws_scheduler_schedule" "poll_lambda" {
  name       = "${local.name_prefix}-poll-schedule"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = "rate(2 minutes)"

  target {
    arn      = aws_lambda_function.poll.arn
    role_arn = aws_iam_role.scheduler_invoke.arn
  }
}

# EventBridge Scheduler invokes the Lambda directly via this execution role
# (not a resource-based aws_lambda_permission, which is how the legacy
# CloudWatch Events rule model works).
resource "aws_iam_role" "scheduler_invoke" {
  name = "${local.name_prefix}-scheduler-invoke-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "scheduler.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = {
    Name = "${local.name_prefix}-scheduler-invoke-role"
  }
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "${local.name_prefix}-scheduler-invoke-policy"
  role = aws_iam_role.scheduler_invoke.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.poll.arn
    }]
  })
}
