# ADR 0001: Database per service

## Status
Accepted

## Context
The platform uses microservices with independent deployability and clear ownership.

## Decision
Each domain service owns a dedicated PostgreSQL database. Cross-service references use UUIDs only (no shared FKs). Progress/analytics use projections from Kafka events.

## Consequences
- Strong isolation and independent schema evolution
- Requires API or event composition for joins
- Operational overhead of multiple databases (mitigated by one Postgres instance with multiple DBs in early stages)
