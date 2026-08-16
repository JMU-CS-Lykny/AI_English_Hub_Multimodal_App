# Architecture snapshot

Full drawings (system overview, gateway, DBs, Kafka, SSE, AI plane, screens, journeys) live in the root [`README.md`](../../README.md#architecture).

ADRs: `docs/adr/`.

## Service ports

| Service | Port |
|---|---|
| web | 3000 |
| gateway | 8080 |
| identity-service | 8081 |
| classroom-service | 8082 |
| content-service | 8083 |
| assessment-service | 8084 |
| notification-service | 8085 |
| ai-orchestration | 8090 |
| ai-rag | 8091 |
| ai-multimodal | 8092 |
| zookeeper | 2181 |
| kafka | 9092 |
| redis | 6379 |
| postgres | 5432 |
| qdrant | 6333 |
| ollama | 11434 |
| ollama-init | — (one-shot) |
| minio (optional) | 9000 / 9001 |
