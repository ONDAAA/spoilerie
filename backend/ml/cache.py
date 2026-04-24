"""
In-process cache for transcript chunks + precomputed chunk embeddings.
Embedding the transcript is the expensive part — cache it per video.
"""

import asyncio
import logging
from typing import Optional
import numpy as np

from .transcript import TranscriptChunk, fetch_transcript, chunk_transcript
from .embedder import embed

logger = logging.getLogger(__name__)

_transcript_cache: dict[str, list[TranscriptChunk] | None] = {}
_embedding_cache: dict[str, np.ndarray] = {}  # video_id → chunk embeddings
_fetch_locks: dict[str, asyncio.Lock] = {}


async def get_chunks(video_id: str) -> Optional[list[TranscriptChunk]]:
    if video_id in _transcript_cache:
        return _transcript_cache[video_id]

    if video_id not in _fetch_locks:
        _fetch_locks[video_id] = asyncio.Lock()

    async with _fetch_locks[video_id]:
        if video_id in _transcript_cache:
            return _transcript_cache[video_id]

        segments = await fetch_transcript(video_id)
        chunks = chunk_transcript(segments) if segments else None
        _transcript_cache[video_id] = chunks

        # Pre-compute chunk embeddings
        if chunks:
            _precompute_embeddings(video_id, chunks)

        return chunks


def store_chunks(video_id: str, chunks: list[TranscriptChunk]) -> None:
    """Store client-provided chunks and precompute their embeddings."""
    _transcript_cache[video_id] = chunks
    _precompute_embeddings(video_id, chunks)


def get_chunk_embeddings(video_id: str) -> Optional[np.ndarray]:
    """Return cached chunk embeddings, or None if not cached."""
    return _embedding_cache.get(video_id)


def _precompute_embeddings(video_id: str, chunks: list[TranscriptChunk]) -> None:
    if video_id in _embedding_cache:
        return
    chunk_texts = [c.text for c in chunks]
    logger.info("Precomputing embeddings for %s (%d chunks)", video_id, len(chunks))
    _embedding_cache[video_id] = embed(chunk_texts)
