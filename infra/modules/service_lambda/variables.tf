# LEARN: In a module, `variable` blocks are the module's PARAMETER LIST. The
# caller must supply every variable that has no default. Because a module
# cannot see its parent's variables or locals, anything it needs - even
# something as basic as the function name - must come in through here.

variable "function_name" {
  type = string
}

variable "role_name" {
  type = string
}

variable "source_file" {
  description = "Built index.mjs; the zip is written next to it."
  type        = string
}

variable "policy_json" {
  description = "Inline IAM policy for the execution role (CloudWatch Logs access is attached separately)."
  type        = string
}

variable "environment" {
  # LEARN: map(string) = key/value pairs where every value is a string -
  # exactly what Lambda environment variables are. (Callers use tostring()
  # to turn a bool into a string, e.g. ARCHIVE_ENABLED in ../../lambda.tf.)
  type = map(string)
}

variable "timeout" {
  type = number
}

variable "memory_size" {
  type = number
}

variable "reserved_concurrent_executions" {
  type = number
  # LEARN: `default = null` makes a variable optional AND means "omit this
  # argument entirely" when passed through. Only poll-lambda overrides it
  # (set to 1 so two polls never run at once).
  default = null
}
