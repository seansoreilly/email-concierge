# LEARN: The top-level `terraform {}` block configures Terraform itself (not
# any cloud). It holds version constraints and the state backend.
terraform {
  # LEARN: Refuse to run on an older Terraform CLI. 1.10 is needed for
  # `use_lockfile` below (S3-native state locking). ">=" means "this or newer".
  required_version = ">= 1.10"

  # LEARN: Declares which providers this config needs and where to download
  # them from. `terraform init` fetches them and records exact versions and
  # checksums in .terraform.lock.hcl (commit that file - it makes everyone use
  # identical provider builds).
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # LEARN: "~> 5.0" is the "pessimistic" operator: any 5.x, never 6.0.
      # Minor/patch upgrades are allowed; a major bump (breaking changes) is
      # a deliberate edit.
      version = "~> 5.0"
    }
  }

  # LEARN: STATE is Terraform's memory: a JSON file mapping every resource in
  # the code to the real AWS object it created (IDs, attributes). Without it
  # Terraform could not tell "create" from "already exists".
  #
  # By default state is a local file. A `backend` stores it remotely instead,
  # which is what you want for anything real: it survives your laptop, can be
  # shared, and supports locking so two applies can't collide.
  #
  # NOTE: backend blocks cannot use variables or locals - values here must be
  # literals. (That is why the bucket name and region are hardcoded.)
  backend "s3" {
    # The S3 bucket holding state. Created outside this config (see
    # infra/bootstrap/) - you cannot store state in a bucket that the same
    # state is trying to create (chicken-and-egg).
    bucket = "email-concierge-tfstate-151444831552"

    # LEARN: `key` is the object path inside the bucket. One key = one
    # independent state. The region is part of the key, so the Sydney stack
    # and the earlier us-east-1 stack are separate states in one bucket.
    key = "email-concierge/ap-southeast-2/terraform.tfstate"

    # The bucket lives in us-east-1 even though the app runs in Sydney - state
    # location and resource location are independent.
    region = "us-east-1"

    # Server-side encrypt the state object. State can contain secrets in plain
    # text (API keys passed as variables end up in it), so this matters.
    encrypt = true

    # LEARN: Locking prevents two `apply`s from running at once and corrupting
    # state. `use_lockfile` writes a lock object next to the state in S3 - the
    # modern replacement for the old DynamoDB lock table.
    use_lockfile = true
  }
}
