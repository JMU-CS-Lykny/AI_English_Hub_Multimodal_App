# Swagger / OpenAPI — manage all services

## Unified hub (recommended)

After `docker compose up --build`:

| Page | URL |
|---|---|
| **Unified Swagger UI** | http://localhost:8080/swagger-ui.html |
| Shortcut | http://localhost:8080/docs |
| Root redirect | http://localhost:8080/ |

Use the top-right **Select a definition** dropdown:

1. `01-identity`
2. `02-classroom`
3. `03-content`
4. `04-assessment`
5. `05-ai-orchestration`
6. `06-ai-rag`
7. `07-ai-multimodal`

### Authorize once, call everything

1. Switch to **01-identity**
2. `POST /api/v1/auth/login`

```json
{
  "email": "teacher@englishhub.vn",
  "password": "Password123!"
}
```

3. Copy `accessToken` from the response
4. Click **Authorize** → paste token (Bearer)
5. Switch to classroom / content / assessment / AI and use **Try it out**

Gateway APIs use `http://localhost:8080` as the OpenAPI server, so Try-it-out goes through JWT validation automatically.

## Per-service Swagger (direct)

| Service | Swagger UI | OpenAPI JSON |
|---|---|---|
| Identity | http://localhost:8081/swagger-ui.html | http://localhost:8081/v3/api-docs |
| Classroom | http://localhost:8082/swagger-ui.html | http://localhost:8082/v3/api-docs |
| Content | http://localhost:8083/swagger-ui.html | http://localhost:8083/v3/api-docs |
| Assessment | http://localhost:8084/swagger-ui.html | http://localhost:8084/v3/api-docs |
| AI Orchestration | http://localhost:8090/docs | http://localhost:8090/openapi.json |
| AI RAG | http://localhost:8091/docs | http://localhost:8091/openapi.json |
| AI Multimodal | http://localhost:8092/docs | http://localhost:8092/openapi.json |

Proxied via gateway (same UIs):

- http://localhost:8080/swagger/identity/swagger-ui.html
- http://localhost:8080/swagger/classroom/swagger-ui.html
- http://localhost:8080/swagger/content/swagger-ui.html
- http://localhost:8080/swagger/assessment/swagger-ui.html

## Stacked docs JSON via gateway

| Definition | Gateway path |
|---|---|
| identity | `/docs-json/identity` |
| classroom | `/docs-json/classroom` |
| content | `/docs-json/content` |
| assessment | `/docs-json/assessment` |
| ai | `/docs-json/ai` |
| rag | `/docs-json/rag` |
| multimodal | `/docs-json/multimodal` |

## Tech

- Java services: **springdoc-openapi** (`/swagger-ui.html`, `/v3/api-docs`)
- Python AI services: **FastAPI** built-in OpenAPI (`/docs`, `/openapi.json`)
- Gateway: **springdoc webflux UI** aggregating all definitions
