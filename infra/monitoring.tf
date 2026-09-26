# No SNS action wired up - an email subscription requires the recipient to
# confirm it, which needs the user's own action. This alarm is a visible,
# narratable artifact (CloudWatch console shows repeated Gmail auth
# failures at a glance) rather than a paging mechanism, per the plan's
# defensive-re-auth-handling note under Open Spikes.
resource "aws_cloudwatch_metric_alarm" "poll_lambda_errors" {
  alarm_name        = "${local.name_prefix}-poll-lambda-errors"
  alarm_description = "poll-lambda errored 3+ times in a 10-minute window - likely a Gmail auth failure or an unexpected crash, not a missing-secret no-op (that path returns 200, not an error)."
  namespace         = "AWS/Lambda"
  metric_name       = "Errors"
  dimensions = {
    FunctionName = aws_lambda_function.poll.function_name
  }
  statistic           = "Sum"
  period              = 600
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  tags = {
    Name = "${local.name_prefix}-poll-lambda-errors"
  }
}
