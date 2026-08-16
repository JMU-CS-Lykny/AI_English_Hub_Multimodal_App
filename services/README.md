# Domain services

## Implemented

| Service | Port | Notes |
|---|---|---|
| `identity-service` | 8081 | Auth, JWT, profile (`/me`, `/profile`), Redis refresh tokens |
| `classroom-service` | 8082 | Classrooms, invite codes, join requests, members; **per-class chat** (messages, attachments, reactions, pin, edit, soft-delete, SSE); Kafka `classroom.events` |
| `content-service` | 8083 | Lessons + publish lifecycle; Kafka toward RAG indexing |
| `assessment-service` | 8084 | Quizzes (`DRAFT` / `PUBLISHED`, kinds EXAM / PRACTICE), Excel import/export, attempts; EXAM publish emits `quiz.exam.scheduled` |
| `notification-service` | 8085 | Inbox + SSE; Kafka on `classroom.events` + `assessment.events`; join resolve from bell; exam reminder scheduler |

## AI plane (see `/ai`)

| Service | Port | Notes |
|---|---|---|
| `ai-orchestration` | 8090 | LangGraph tutor, detect-subject, generate-quiz, multimodal façade |
| `ai-rag` | 8091 | Embeddings + Qdrant retrieval |
| `ai-multimodal` | 8092 | STT / vision / image / video helpers |

## Edge & web (see repo root)

| Service | Port | Notes |
|---|---|---|
| `gateway` | 8080 | JWT, Swagger hub, SSE proxy (inbox / chat / tutor), 16MB JSON |
| `web` | 3000 | Next.js home hub, classroom chat, quizzes, exam, AI Mascot |

## Data (Compose)

Postgres, Redis, Kafka + ZooKeeper, Qdrant, Ollama (+ `ollama-init`). Optional MinIO via profile `storage`.

## Planned later

- `game-service`
- `progress-service`
- `media-service`
- `user-service` (profile/CEFR; identity currently carries basic profile fields)
