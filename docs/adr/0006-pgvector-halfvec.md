# ADR 0006: Store embeddings as pgvector `halfvec(2048)`

- Status: accepted (2026-08-23, Alembic revision 0002)
- Phase docs: [phase-5](../phase-5.md) (deviation 17)

## Context

The RAG index lives in the app's own Postgres (`ai.document_chunks`, owned
by Alembic), searched with an HNSW index. The chosen embedding model
(ADR 0005) returns 2,048 dimensions and cannot be shortened. pgvector's HNSW
index supports the `vector` type only up to 2,000 dimensions; `halfvec`
(16-bit floats) is indexable up to 4,000.

## Decision

The embedding column is `halfvec(2048)` with an HNSW index using cosine
distance, and the existing chunks were re-embedded. A chunk records the
model that produced it; a source with chunks from another model counts as
stale, so changing `AI_EMBED_MODEL` re-indexes it on the next sweep.

## Consequences

- Half the storage per vector of `vector(2048)`, on a 0.5 GB free database.
- 16-bit precision; retrieval recall@6 on the live eval was 1.0 over 40
  questions, so no loss was visible at this size.
- A model change means a full re-embed, done in bounded batches by the
  hourly `ai.sweep`.
- Backups leave the index out; it is rebuilt from the source rows (ADR 0008).
