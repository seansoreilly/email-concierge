locals {
  name_prefix = var.project_name

  # IAM roles are an account-global namespace, unlike every other resource
  # here (DynamoDB, Lambda, Secrets Manager, Amplify are all region-scoped) -
  # region-qualify role names so a second regional stack can coexist in the
  # same AWS account without name collisions.
  iam_name_prefix = "${local.name_prefix}-${var.aws_region}"

  lambda_names = {
    poll  = "${local.name_prefix}-poll-lambda"
    draft = "${local.name_prefix}-draft-lambda"
    api   = "${local.name_prefix}-api-lambda"
  }

  dynamodb_table_names = {
    emails     = "${local.name_prefix}-emails"
    sync_state = "${local.name_prefix}-sync-state"
  }

  secret_names = {
    gmail_oauth = "${local.name_prefix}/gmail-oauth"
  }

  # Each Lambda's package.json "build" script must emit exactly this path via esbuild -
  # infra's data.archive_file zips it, so the path is a hard contract between infra/ and services/.
  lambda_dist_path = {
    poll  = "${path.module}/../services/poll-lambda/dist/index.mjs"
    draft = "${path.module}/../services/draft-lambda/dist/index.mjs"
    api   = "${path.module}/../services/api-lambda/dist/index.mjs"
  }
}
