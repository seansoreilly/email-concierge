# LEARN: `locals` are private named values, computed once and reused as
# `local.<name>`. Unlike variables they cannot be set from outside; unlike
# outputs they are not shown anywhere. Think "const" inside a function. Use
# them to avoid repeating an expression, and to put naming rules in one place.
locals {
  name_prefix = var.project_name

  # IAM roles are an account-global namespace, unlike every other resource
  # here (DynamoDB, Lambda, Secrets Manager, Amplify are all region-scoped) -
  # region-qualify role names so a second regional stack can coexist in the
  # same AWS account without name collisions.
  #
  # LEARN: "${...}" is string interpolation - any expression can go inside.
  # Result for the live stack: "email-concierge-ap-southeast-2".
  iam_name_prefix = "${local.name_prefix}-${var.aws_region}"

  # LEARN: A local can be a map (key => value). Access with dot syntax,
  # `local.lambda_names.poll`, or index syntax, `local.lambda_names["poll"]`.
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
  #
  # LEARN: `path.module` is the directory of the .tf file being evaluated
  # (here: infra/), so these paths work no matter where you run terraform from.
  # (`path.root` would be the directory you ran terraform in - the same thing
  # in this repo, but different inside a child module.)
  lambda_dist_path = {
    poll  = "${path.module}/../services/poll-lambda/dist/index.mjs"
    draft = "${path.module}/../services/draft-lambda/dist/index.mjs"
    api   = "${path.module}/../services/api-lambda/dist/index.mjs"
  }
}
