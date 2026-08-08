# ADR 0003: Classroom join approval with realtime notifications

## Status
Accepted

## Context
Students currently join classrooms immediately via invite code. Teachers need to approve or reject join requests, and both sides need near-real-time notifications.

## Decision
1. Change enroll flow to **request → teacher decision → membership**.
2. `classroom-service` owns `join_requests` and creates `classroom_members` only on Accept.
3. `notification-service` owns inbox persistence and **SSE** delivery for synchronous UX.
4. Kafka carries domain events (`join_request.created|accepted|rejected`, `student.enrolled`).
5. Gateway exposes `/api/v1/notifications/**` and proxies SSE with JWT (`Authorization` or `access_token` query for EventSource).

## Consequences
- Breaking change vs previous auto-join semantics (`/join` now aliases request-create).
- notification-service added to compose on port 8085.
- SSE is simpler than WebSocket for one-way inbox push.
