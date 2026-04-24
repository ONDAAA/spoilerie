import logging
import time

from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel, Field

from ml.cache import get_chunks
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


class AnalyzeRequest(BaseModel):
    video_id: str = Field(alias="videoId")
    current_time: float = Field(alias="currentTime", ge=0)
    video_duration: float = Field(alias="videoDuration", ge=0)
    comments: list[CommentIn]

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

    logger.info(
        "analyze: video=%s time=%.0f comments=%d tier=%s",
        req.video_id, req.current_time, len(req.comments), tier,
    )

    t0 = time.monotonic()
    chunks = await get_chunks(req.video_id)

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
    )

    spoilers_found = sum(1 for r in raw if r.is_spoiler and r.confidence > 0.5)
    processing_ms = int((time.monotonic() - t0) * 1000)

    # Log usage (fire and forget)
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
