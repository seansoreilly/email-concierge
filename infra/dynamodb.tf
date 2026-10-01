# LEARN: This is the simplest kind of file: plain `resource` blocks.
#   resource "<TYPE>" "<LOCAL NAME>" { ...arguments... }
# TYPE (aws_dynamodb_table) says what to build and comes from the provider's
# docs. LOCAL NAME (emails) is just a handle for referencing it elsewhere as
# `aws_dynamodb_table.emails.<attribute>`. It is NOT the AWS name - that is the
# `name` argument. Renaming the local name makes Terraform think it is a NEW
# resource (destroy + create) unless you add a `moved {}` block (see lambda.tf).

# emails table: one item per Gmail message, keyed by messageId. Streams enabled
# (NEW_IMAGE) so draft-lambda can react to newly-classified "To Respond" emails
# without polling DynamoDB itself.
resource "aws_dynamodb_table" "emails" {
  name = local.dynamodb_table_names.emails

  # PAY_PER_REQUEST = on-demand: no capacity planning, billed per read/write.
  # Right for a tiny, spiky workload; PROVISIONED is cheaper at steady scale.
  billing_mode = "PAY_PER_REQUEST"

  # The partition (primary) key. DynamoDB is schemaless except for key
  # attributes, which is why only messageId is declared below.
  hash_key = "messageId"

  # LEARN: A nested block (no `=`). `attribute` can repeat. Types: S = string,
  # N = number, B = binary. Only attributes used in keys/indexes go here.
  attribute {
    name = "messageId"
    type = "S"
  }

  # DynamoDB Streams emits a change record per write. NEW_IMAGE = the record
  # carries the item as it looks AFTER the write. lambda.tf subscribes
  # draft-lambda to this stream via aws_lambda_event_source_mapping.
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"
}

# sync_state table: a single item holding the Gmail historyId cursor (pk = a
# fixed string like "gmail-history-cursor"). Idempotent updates are handled at
# the application level via DynamoDB ConditionExpression on PutItem/UpdateItem;
# nothing extra to configure here.
resource "aws_dynamodb_table" "sync_state" {
  name         = local.dynamodb_table_names.sync_state
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
}
