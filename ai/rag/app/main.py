from __future__ import annotations

import hashlib
import os
import re
import uuid
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel, Field
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
COLLECTION = os.getenv("COLLECTION_NAME", "lesson_chunks")
VECTOR_SIZE = int(os.getenv("VECTOR_SIZE", "768"))
OPENAPI_SERVER_URL = os.getenv("OPENAPI_SERVER_URL", "http://localhost:8091")

app = FastAPI(
    title="AI English Hub — RAG Service",
    description="LlamaIndex-style chunking + Qdrant retrieval for lesson grounding.",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

client = QdrantClient(url=QDRANT_URL)


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    schema["servers"] = [{"url": OPENAPI_SERVER_URL, "description": "RAG service direct"}]
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = custom_openapi  # type: ignore[method-assign]


class IndexRequest(BaseModel):
    lesson_id: str
    classroom_id: str
    title: str
    body: str


class RetrieveRequest(BaseModel):
    query: str = Field(min_length=1)
    classroom_id: str | None = None
    top_k: int = 4


def ensure_collection() -> None:
    names = {c.name for c in client.get_collections().collections}
    if COLLECTION not in names:
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=qm.VectorParams(size=VECTOR_SIZE, distance=qm.Distance.COSINE),
        )


def chunk_text(text: str, max_chars: int = 600) -> list[str]:
    parts = re.split(r"\n{2,}|(?<=[.!?])\s+", text.strip())
    chunks: list[str] = []
    buf = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if len(buf) + len(p) + 1 <= max_chars:
            buf = f"{buf} {p}".strip()
        else:
            if buf:
                chunks.append(buf)
            buf = p
    if buf:
        chunks.append(buf)
    return chunks or [text[:max_chars]]


async def embed(texts: list[str]) -> list[list[float]]:
    vectors: list[list[float]] = []
    async with httpx.AsyncClient(timeout=60) as http:
        for t in texts:
            try:
                r = await http.post(
                    f"{OLLAMA_BASE_URL}/api/embeddings",
                    json={"model": OLLAMA_EMBED_MODEL, "prompt": t},
                )
                if r.status_code == 200 and "embedding" in r.json():
                    vectors.append(r.json()["embedding"])
                    continue
            except httpx.HTTPError:
                pass
            # Deterministic fallback embedding for local/dev without embed model
            vectors.append(_fallback_vector(t))
    return vectors


def _fallback_vector(text: str) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    vals = []
    while len(vals) < VECTOR_SIZE:
        digest = hashlib.sha256(digest + text.encode("utf-8")).digest()
        vals.extend(b / 255.0 for b in digest)
    return vals[:VECTOR_SIZE]


@app.on_event("startup")
def on_startup() -> None:
    try:
        ensure_collection()
    except Exception:
        # Qdrant may not be up yet in compose race; endpoints will retry
        pass


@app.get("/health", tags=["Health"])
def health():
    return {"status": "ok", "service": "ai-rag", "collection": COLLECTION}


@app.post("/v1/index", tags=["Indexing"])
async def index_lesson(body: IndexRequest):
    ensure_collection()
    chunks = chunk_text(body.body)
    vectors = await embed(chunks)
    points = []
    for i, (chunk, vector) in enumerate(zip(chunks, vectors)):
        points.append(
            qm.PointStruct(
                id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{body.lesson_id}:{i}")),
                vector=vector,
                payload={
                    "lesson_id": body.lesson_id,
                    "classroom_id": body.classroom_id,
                    "title": body.title,
                    "text": chunk,
                },
            )
        )
    client.upsert(collection_name=COLLECTION, points=points)
    return {"indexed": len(points), "lesson_id": body.lesson_id}


@app.post("/v1/retrieve", tags=["Retrieval"])
async def retrieve(body: RetrieveRequest):
    ensure_collection()
    query_vec = (await embed([body.query]))[0]
    query_filter = None
    if body.classroom_id:
        query_filter = qm.Filter(
            must=[qm.FieldCondition(key="classroom_id", match=qm.MatchValue(value=body.classroom_id))]
        )
    hits = client.search(
        collection_name=COLLECTION,
        query_vector=query_vec,
        query_filter=query_filter,
        limit=body.top_k,
    )
    chunks: list[dict[str, Any]] = []
    for h in hits:
        payload = h.payload or {}
        chunks.append(
            {
                "lesson_id": payload.get("lesson_id"),
                "classroom_id": payload.get("classroom_id"),
                "title": payload.get("title"),
                "text": payload.get("text"),
                "score": h.score,
            }
        )
    return {"chunks": chunks}
