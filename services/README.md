# Domain services

## Implemented

| Service | Port | Notes |
|---|---|---|
| `identity-service` | 8081 | Auth, JWT, profile (`/me`, `/profile`), Redis refresh tokens |
| `classroom-service` | 8082 | Classrooms, invite codes, join requests, members; Kafka `classroom.events` |
| `content-service` | 8083 | Lessons + publish lifecycle; Kafka toward RAG indexing |
| `assessment-service` | 8084 | Quizzes (`DRAFT` / `PUBLISHED`), Excel import/export, attempts |
| `notification-service` | 8085 | Inbox + SSE; Kafka consumer on `classroom.events`; join resolve from bell |

## AI plane (see `/ai`)

| Service | Port | Notes |
|---|---|---|
| `ai-orchestration` | 8090 | LangGraph tutor, detect-subject, generate-quiz, multimodal façade |
| `ai-rag` | 8091 | Embeddings + Qdrant retrieval |
| `ai-multimodal` | 8092 | STT / vision / image / video helpers |

## Planned later

- `game-service`
- `progress-service`
- `media-service`
- `user-service` (profile/CEFR; identity currently carries basic profile fields)
