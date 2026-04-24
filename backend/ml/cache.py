"""
Simple in-process cache for transcript chunks + embeddings.
In production swap for Redis with pickle serialization.
"""

import asyncio
from typing import Optional
from .transcript import TranscriptChunk, fetch_transcript, chunk_transcript

_transcript_cache: dict[str, list[TranscriptChunk] | None] = {}
_fetch_locks: dict[str, asyncio.Lock] = {}


async def get_chunks(video_id: str) -> Optional[list[TranscriptChunk]]:
    if video_id in _transcript_cache:
        return _transcript_cache[video_id]

    if video_id not in _fetch_locks:
        _fetch_locks[video_id] = asyncio.Lock()

    async with _fetch_locks[video_id]:
        # double-check after acquiring lock
        if video_id in _transcript_cache:
            return _transcript_cache[video_id]

        segments = await fetch_transcript(video_id)
        chunks = chunk_transcript(segments) if segments else None
        _transcript_cache[video_id] = chunks
        return chunks
