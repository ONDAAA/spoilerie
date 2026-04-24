import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel, Field

from ml.cache import get_chunks, store_chunks, get_chunk_embeddings
from ml.transcript import TranscriptSegment, chunk_transcript
from ml.classifier import classify_comments
from ..rate_limit import limiter, FREE_LIMIT, PRO_LIMIT
from ..auth import get_current_user, check_usage_limit, log_usage, User, TIER_PRO

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_COMMENTS_FREE = 30
MAX_COMMENTS_PRO = 100


class CommentIn(BaseModel):
    id: str
    text: str = Field(max_length=5000)


class TranscriptSegmentIn(BaseModel):
    text: str
    start: float
    duration: float


class AnalyzeRequest(BaseModel):
    video_id: str = Field(alias="videoId")
    current_time: float = Field(alias="currentTime", ge=0)
    video_duration: float = Field(alias="videoDuration", ge=0)
    comments: list[CommentIn]
    transcript: Optional[list[TranscriptSegmentIn]] = None

    model_config = {"populate_by_name": True}


class AnalyzeResult(BaseModel):
    comment_id: str = Field(serialization_alias="commentId")
    estimated_timestamp: float | None = Field(serialization_alias="estimatedTimestamp")
    is_spoiler: bool = Field(serialization_alias="isSpoiler")
    confidence: float

    model_config = {"populate_by_name": True}


class AnalyzeResponse(BaseModel):
    results: list[AnalyzeResult]
    transcript_available: bool = Field(serialization_alias="transcriptAvailable")

    model_config = {"populate_by_name": True}


@router.post("/analyze", response_model=AnalyzeResponse, response_model_by_alias=True)
@limiter.limit(FREE_LIMIT)
async def analyze(request: Request, req: AnalyzeRequest):
    if not req.comments:
        raise HTTPException(status_code=400, detail="No comments provided")

    # Auth + tier + usage check
    user = await get_current_user(request)
    tier = user.tier if user else "free"
    await check_usage_limit(user)

    max_comments = MAX_COMMENTS_PRO if tier == TIER_PRO else MAX_COMMENTS_FREE
    if len(req.comments) > max_comments:
        req.comments = req.comments[:max_comments]

    t0 = time.monotonic()

    # Check if we already have cached chunks + embeddings for this video
    chunks = await get_chunks(req.video_id) if not req.transcript else None
    cached_embs = get_chunk_embeddings(req.video_id)

    if chunks and cached_embs is not None:
        # Fast path: everything cached, only embed the new comments
        logger.info(
            "analyze: video=%s time=%.0f comments=%d tier=%s [CACHED]",
            req.video_id, req.current_time, len(req.comments), tier,
        )
    elif req.transcript and len(req.transcript) > 0:
        # Client provided transcript — chunk it and cache
        segments = [
            TranscriptSegment(text=s.text, start=s.start, duration=s.duration)
            for s in req.transcript
        ]
        chunks = chunk_transcript(segments)
        store_chunks(req.video_id, chunks)
        cached_embs = get_chunk_embeddings(req.video_id)
        logger.info(
            "analyze: video=%s time=%.0f comments=%d tier=%s transcript=client(%d segs, now cached)",
            req.video_id, req.current_time, len(req.comments), tier, len(segments),
        )
    else:
        # Fetch server-side
        chunks = await get_chunks(req.video_id)
        cached_embs = get_chunk_embeddings(req.video_id) if chunks else None
        logger.info(
            "analyze: video=%s time=%.0f comments=%d tier=%s transcript=%s",
            req.video_id, req.current_time, len(req.comments), tier,
            f"server({len(chunks)} chunks)" if chunks else "unavailable",
        )

    if chunks is None:
        return AnalyzeResponse(
            results=[
                AnalyzeResult(
                    comment_id=c.id,
                    estimated_timestamp=None,
                    is_spoiler=False,
                    confidence=0.0,
                )
                for c in req.comments
            ],
            transcript_available=False,
        )

    raw = classify_comments(
        comments=[(c.id, c.text) for c in req.comments],
        chunks=chunks,
        current_time=req.current_time,
        video_duration=req.video_duration,
        chunk_embeddings=cached_embs,
    )

    spoilers_found = sum(1 for r in raw if r.is_spoiler and r.confidence > 0.5)
    processing_ms = int((time.monotonic() - t0) * 1000)

    await log_usage(user, req.video_id, len(req.comments), spoilers_found, processing_ms)

    return AnalyzeResponse(
        results=[
            AnalyzeResult(
                comment_id=r.comment_id,
                estimated_timestamp=r.estimated_timestamp,
                is_spoiler=r.is_spoiler,
                confidence=r.confidence,
            )
            for r in raw
        ],
        transcript_available=True,
    )
