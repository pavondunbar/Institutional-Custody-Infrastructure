output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "rds_endpoint" {
  value = aws_rds_cluster.main.endpoint
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "kafka_brokers" {
  value = aws_msk_cluster.main.bootstrap_brokers_tls
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}
