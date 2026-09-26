# emails table: one item per Gmail message, keyed by messageId. Streams enabled
# (NEW_IMAGE) so draft-lambda can react to newly-classified "To Respond" emails
# without polling DynamoDB itself.
resource "aws_dynamodb_table" "emails" {
  name         = local.dynamodb_table_names.emails
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "messageId"

  attribute {
    name = "messageId"
    type = "S"
  }

  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  tags = {
    Name = local.dynamodb_table_names.emails
  }
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

  tags = {
    Name = local.dynamodb_table_names.sync_state
  }
}
