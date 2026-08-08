# ADR 0002: AI capability plane

## Status
Accepted

## Context
Teachers and students need multimodal AI tutoring grounded in classroom content.

## Decision
- Domain logic stays in Spring Boot Java services
- AI orchestration uses LangGraph (Python)
- RAG uses LlamaIndex-style indexing pipeline + Qdrant
- LLMs served by private Ollama (never exposed via public Gateway)
- Multimodal STT/TTS/vision is a separate Python service

## Consequences
- Clear language/runtime split
- Extra network hop Java → Python for AI
- Allows GPU scaling independent of domain services
