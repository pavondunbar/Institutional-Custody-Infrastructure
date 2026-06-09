variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "db_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.r6g.large"
}

variable "app_image" {
  type        = string
  description = "ECR image URI for the app container"
}

variable "app_desired_count" {
  type    = number
  default = 3
}

variable "kafka_instance_type" {
  type    = string
  default = "kafka.m5.large"
}
