"""Fetches and chunks YouTube transcripts with timestamps."""

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from youtube_transcript_api import YouTubeTranscriptApi

logger = logging.getLogger(__name__)


@dataclass
class TranscriptSegment:
    text: str
    start: float   # seconds
    duration: float


@dataclass
class TranscriptChunk:
    text: str
    start: float
    end: float


_api = YouTubeTranscriptApi()


async def fetch_transcript(video_id: str) -> Optional[list[TranscriptSegment]]:
    """
    Fetches transcript via youtube-transcript-api (runs in thread to avoid blocking).
    Prefers English, falls back to first available language.
    Returns None if no transcript is available.
    """

    def _fetch() -> Optional[list]:
        try:
            transcript_list = _api.list(video_id)

            snippets = None
            for lang_codes in [["en"], ["en-US"], ["en-GB"]]:
                try:
                    found = transcript_list.find_transcript(lang_codes)
                    snippets = list(found.fetch())
                    break
                except Exception:
                    continue

            if not snippets:
                first = next(iter(transcript_list))
                snippets = list(first.fetch())

            return snippets
        except Exception as e:
            logger.warning("Failed to fetch transcript for %s: %s", video_id, e)
            return None

    snippets = await asyncio.to_thread(_fetch)

    if not snippets:
        return None

    segments = [
        TranscriptSegment(
            text=s.text.strip(),
            start=s.start,
            duration=s.duration,
        )
        for s in snippets
        if s.text.strip()
    ]
    return segments if segments else None


def chunk_transcript(
    segments: list[TranscriptSegment],
    window_seconds: float = 45.0,
    step_seconds: float = 15.0,
) -> list[TranscriptChunk]:
    """
    Sliding window over transcript segments -> overlapping chunks with timestamps.
    Smaller step = better timestamp resolution at the cost of more embeddings.
    """
    if not segments:
        return []

    chunks: list[TranscriptChunk] = []
    total_duration = segments[-1].start + segments[-1].duration

    t = 0.0
    while t < total_duration:
        window_end = t + window_seconds
        window_segs = [s for s in segments if s.start >= t and s.start < window_end]
        if window_segs:
            text = " ".join(s.text for s in window_segs)
            chunks.append(TranscriptChunk(text=text, start=t, end=min(window_end, total_duration)))
        t += step_seconds

    return chunks
