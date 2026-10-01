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
  type = map(string)
}

variable "timeout" {
  type = number
}

variable "memory_size" {
  type = number
}

variable "reserved_concurrent_executions" {
  type    = number
  default = null
}
