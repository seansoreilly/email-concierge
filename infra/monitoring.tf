# No SNS action wired up - an email subscription requires the recipient to
# confirm it, which needs the user's own action. This alarm is a visible,
# narratable artifact (CloudWatch console shows repeated Gmail auth
# failures at a glance) rather than a paging mechanism, per the plan's
# defensive-re-auth-handling note under Open Spikes.
#
# LEARN: A CloudWatch alarm = "watch one metric, compare to a threshold".
# Reading the arguments top to bottom as a sentence: "Over each 600-second
# period, take the Sum of AWS/Lambda Errors for poll-lambda; if that is >= 3
# for 1 consecutive period, go to ALARM."
resource "aws_cloudwatch_metric_alarm" "poll_lambda_errors" {
  alarm_name        = "${local.name_prefix}-poll-lambda-errors"
  alarm_description = "poll-lambda errored 3+ times in a 10-minute window - likely a Gmail auth failure or an unexpected crash, not a missing-secret no-op (that path returns 200, not an error)."
  namespace         = "AWS/Lambda"
  metric_name       = "Errors"
  # LEARN: Metrics are identified by name PLUS dimensions. Without this
  # dimension the alarm would aggregate errors across ALL Lambdas in the
  # account. (A map argument uses `=`; nested blocks like `target {}` do not.)
  dimensions = {
    FunctionName = module.poll.function_name
  }
  statistic          = "Sum"
  period             = 600
  evaluation_periods = 1
  threshold          = 3
  # `>= threshold` triggers the alarm.
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # When Lambda has no invocations there is no data point; treat that as
  # healthy rather than flipping to INSUFFICIENT_DATA.
  treat_missing_data = "notBreaching"
}
