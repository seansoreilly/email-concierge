# Shell only - no aws_secretsmanager_secret_version here. The Gmail OAuth
# client id/secret/refresh token JSON is populated out-of-band by Phase 4's
# scripts/oauth-bootstrap.ts via `aws secretsmanager put-secret-value`, not by
# Terraform. recovery_window_in_days = 0 forces immediate deletion (rather
# than the default 30-day recovery window) so a destroy/recreate cycle during
# demo iteration doesn't collide with a "scheduled for deletion" name conflict.
#
# LEARN: Why keep the secret VALUE out of Terraform? Anything Terraform sets
# is written to state in plain text, and the refresh token comes from an
# interactive browser consent that Terraform cannot perform anyway. So
# Terraform owns the secret's existence + IAM access to it, and a script owns
# its contents. This split ("infra vs. data") is common for secrets.
#
# LEARN: Other files reference this as aws_secretsmanager_secret.gmail_oauth.arn.
# That reference does two jobs: it passes the value AND tells Terraform to
# create the secret before anything that uses it (an implicit dependency).
resource "aws_secretsmanager_secret" "gmail_oauth" {
  name                    = local.secret_names.gmail_oauth
  description             = "Gmail OAuth client id/secret/refresh token (populated by Phase 4 bootstrap script, not Terraform)"
  recovery_window_in_days = 0
}
